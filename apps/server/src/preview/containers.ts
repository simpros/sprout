import { parsePreviewContainerName, previewContainerName } from "./naming.ts";

export type CatalogContainer = {
  containerId: string;
  containerName: string;
  slug: string;
  prId: number;
};

export type ContainerPorts = {
  listPreviewContainers: () => Promise<CatalogContainer[]>;
  remove: (opts: { slug: string; prId: number }) => Promise<void>;
};

export type DockerRemoverOptions = {
  socketPath?: string;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit & { unix?: string },
  ) => Promise<Response>;
};

type DockerContainerRow = {
  Id: string;
  Names?: string[];
};

/** Minimal Docker engine list + remove by id or preview container name. */
export function createDockerRemover(
  options: DockerRemoverOptions = {},
): ContainerPorts {
  const socketPath = options.socketPath ?? "/var/run/docker.sock";
  const fetchImpl = options.fetch ?? fetch;

  async function removeByRef(ref: string): Promise<void> {
    const url = `http://localhost/containers/${encodeURIComponent(ref)}?force=true`;
    const res = await fetchImpl(url, {
      method: "DELETE",
      unix: socketPath,
    });
    // 204 removed, 404 already gone — both fine for sweep
    if (res.status !== 204 && res.status !== 404) {
      const body = await res.text();
      throw new Error(`Docker remove ${ref} failed: ${res.status} ${body}`);
    }
  }

  return {
    async listPreviewContainers() {
      const filters = encodeURIComponent(JSON.stringify({ name: ["pb-"] }));
      const url = `http://localhost/containers/json?all=true&filters=${filters}`;
      const res = await fetchImpl(url, {
        method: "GET",
        unix: socketPath,
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
          out.push({
            containerId: row.Id,
            containerName: name,
            slug: parsed.slug,
            prId: parsed.prId,
          });
          break;
        }
      }
      return out;
    },
    async remove({ slug, prId }) {
      // 204/404 ok; hard fail throws
      await removeByRef(previewContainerName(slug, prId));
    },
  };
}
