import {
  parsePreviewContainerName,
  toCatalogContainer,
} from "../preview/naming.ts";
import type {
  CatalogContainer,
  ContainerCreateSpec,
  PreviewDocker,
} from "./port.ts";
import {
  imageNameWithoutTagOrDigest,
  xRegistryAuthHeader,
  type RegistryPullAuth,
} from "../registry-auth.ts";

export type DockerEngineOptions = {
  socketPath?: string;
  /** Boot-normalized registry pull auth (per-host map + optional fallback). */
  registryPullAuth?: RegistryPullAuth;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit & { unix?: string },
  ) => Promise<Response>;
};

type DockerContainerRow = {
  Id: string;
  Names?: string[];
};

type ImageInspect = {
  Config?: {
    ExposedPorts?: Record<string, unknown>;
  };
};

function splitImageRef(image: string): { fromImage: string; tag: string } {
  const fromImage = imageNameWithoutTagOrDigest(image);
  if (fromImage.length === image.length) {
    return { fromImage, tag: "latest" };
  }
  return { fromImage, tag: image.slice(fromImage.length + 1) };
}

function firstExposedPortFromInspect(inspect: ImageInspect): number | null {
  const exposed = inspect.Config?.ExposedPorts;
  if (!exposed) return null;
  for (const key of Object.keys(exposed)) {
    const match = /^(\d+)\//.exec(key);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Docker multiplexed log stream: 8-byte header (stream type + big-endian size)
 * then payload. Preview containers are created without Tty, so Engine always
 * multiplexes stdout/stderr — always demux (no raw/TTY fallback).
 */
function demuxDockerLogs(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  if (bytes.length === 0) return "";

  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size =
      ((bytes[offset + 4]! << 24) |
        (bytes[offset + 5]! << 16) |
        (bytes[offset + 6]! << 8) |
        bytes[offset + 7]!) >>>
      0;
    offset += 8;
    if (offset + size > bytes.length) break;
    chunks.push(decoder.decode(bytes.subarray(offset, offset + size)));
    offset += size;
  }
  return chunks.join("");
}

/**
 * Engine `/images/create` often returns HTTP 200 and encodes failure as
 * `{"error":...}` / `errorDetail` lines in the NDJSON progress body.
 */
function assertPullStreamOk(body: string, image: string): void {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const row = obj as {
      error?: unknown;
      errorDetail?: { message?: unknown };
    };
    const message =
      (typeof row.error === "string" && row.error) ||
      (typeof row.errorDetail?.message === "string" &&
        row.errorDetail.message) ||
      null;
    if (message) {
      throw new Error(`Docker pull ${image} failed: ${message}`);
    }
  }
}

/** Docker Engine API client over the unix socket (preview-scoped). */
export function createDockerEngineClient(
  options: DockerEngineOptions = {},
): PreviewDocker {
  const socketPath = options.socketPath ?? "/var/run/docker.sock";
  const fetchImpl = options.fetch ?? fetch;
  const registryPullAuth: RegistryPullAuth = options.registryPullAuth ?? {
    byHost: new Map(),
  };

  async function engine(
    path: string,
    init: RequestInit & { unix?: string } = {},
  ): Promise<Response> {
    return fetchImpl(`http://localhost${path}`, {
      ...init,
      unix: socketPath,
    });
  }

  async function removeByName(name: string): Promise<void> {
    const res = await engine(
      `/containers/${encodeURIComponent(name)}?force=true`,
      { method: "DELETE" },
    );
    if (res.status !== 204 && res.status !== 404) {
      const body = await res.text();
      throw new Error(`Docker remove ${name} failed: ${res.status} ${body}`);
    }
  }

  return {
    async pullImage(image) {
      const { fromImage, tag } = splitImageRef(image);
      const qs = new URLSearchParams({ fromImage, tag });
      const headers: Record<string, string> = {};
      const registryAuthHeader = xRegistryAuthHeader(image, registryPullAuth);
      if (registryAuthHeader) {
        headers["X-Registry-Auth"] = registryAuthHeader;
      }
      const res = await engine(`/images/create?${qs}`, {
        method: "POST",
        headers,
      });
      // Drain the progress stream body so the pull completes.
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`Docker pull ${image} failed: ${res.status}`);
      }
      assertPullStreamOk(body, image);
    },

    async firstExposedPort(image) {
      const res = await engine(`/images/${encodeURIComponent(image)}/json`, {
        method: "GET",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Docker inspect image ${image} failed: ${res.status} ${body}`,
        );
      }
      return firstExposedPortFromInspect((await res.json()) as ImageInspect);
    },

    removeByName,

    async createAndStart(spec: ContainerCreateSpec) {
      if (spec.networkNames.length === 0) {
        throw new Error("createAndStart requires at least one network");
      }
      const endpoints: Record<string, Record<string, never>> = {};
      for (const n of spec.networkNames) {
        endpoints[n!] = {};
      }
      const createRes = await engine(
        `/containers/create?name=${encodeURIComponent(spec.name)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            Image: spec.image,
            Env: spec.env,
            Labels: spec.labels,
            ...(spec.cmd !== undefined ? { Cmd: spec.cmd } : {}),
            NetworkingConfig: {
              EndpointsConfig: endpoints,
            },
          }),
        },
      );
      if (!createRes.ok) {
        const body = await createRes.text();
        throw new Error(
          `Docker create ${spec.name} failed: ${createRes.status} ${body}`,
        );
      }
      const { Id: id } = (await createRes.json()) as { Id: string };

      try {
        const startRes = await engine(
          `/containers/${encodeURIComponent(id)}/start`,
          { method: "POST" },
        );
        if (!startRes.ok && startRes.status !== 304) {
          const body = await startRes.text();
          throw new Error(
            `Docker start ${spec.name} failed: ${startRes.status} ${body}`,
          );
        }
        return { id };
      } catch (err) {
        // Half-built named container blocks the next replace; best-effort scrub.
        try {
          await removeByName(spec.name);
        } catch {
          // ignore — surface the original start failure
        }
        throw err;
      }
    },

    async waitForExit(containerId, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await engine(
          `/containers/${encodeURIComponent(containerId)}/wait`,
          { method: "POST", signal: controller.signal },
        );
        if (!res.ok) {
          const body = await res.text();
          throw new Error(
            `Docker wait ${containerId} failed: ${res.status} ${body}`,
          );
        }
        const payload = (await res.json()) as { StatusCode?: number };
        if (typeof payload.StatusCode !== "number") {
          throw new Error(
            `Docker wait ${containerId} returned no StatusCode`,
          );
        }
        return { timedOut: false, exitCode: payload.StatusCode };
      } catch (err) {
        if (controller.signal.aborted) {
          return { timedOut: true };
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    async containerIpOnNetwork(containerId, networkName) {
      const res = await engine(
        `/containers/${encodeURIComponent(containerId)}/json`,
        { method: "GET" },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Docker inspect ${containerId} failed: ${res.status} ${body}`,
        );
      }
      const inspect = (await res.json()) as {
        NetworkSettings?: {
          Networks?: Record<string, { IPAddress?: string }>;
        };
      };
      const ip =
        inspect.NetworkSettings?.Networks?.[networkName]?.IPAddress?.trim() ??
        "";
      return ip === "" ? null : ip;
    },

    async containerLogs(nameOrId, options) {
      const qs = new URLSearchParams({
        stdout: "1",
        stderr: "1",
        timestamps: "0",
        follow: "0",
        tail: String(options.tail),
      });
      const res = await engine(
        `/containers/${encodeURIComponent(nameOrId)}/logs?${qs}`,
        { method: "GET" },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Docker logs ${nameOrId} failed: ${res.status} ${body}`,
        );
      }
      return demuxDockerLogs(new Uint8Array(await res.arrayBuffer()));
    },

    async listPreviewContainers() {
      const filters = encodeURIComponent(JSON.stringify({ name: ["sprout-"] }));
      const res = await engine(`/containers/json?all=true&filters=${filters}`, {
        method: "GET",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Docker list containers failed: ${res.status} ${body}`);
      }
      const rows = (await res.json()) as DockerContainerRow[];
      const out: CatalogContainer[] = [];
      for (const row of rows) {
        for (const rawName of row.Names ?? []) {
          const name = rawName.replace(/^\//, "");
          const parsed = parsePreviewContainerName(name);
          if (!parsed) continue;
          out.push(toCatalogContainer(row.Id, name, parsed));
          break;
        }
      }
      return out;
    },
  };
}

export { assertPullStreamOk, demuxDockerLogs, firstExposedPortFromInspect, splitImageRef };
