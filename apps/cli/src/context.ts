import type { ApiClient } from "@sprout/api-client";
import {
  HOSTNAME_PLACEHOLDER,
  substituteHostname as substitutePreviewHostname,
  validateHostname,
} from "@sprout/preview-env";
import {
  normalizeGitRemoteUrl,
  resolveCanonicalRepoId,
  resolvePrId,
} from "./identity.ts";
import type { Result } from "./result.ts";
import { parseSproutYaml, type SproutYaml } from "./yaml.ts";

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readTextFile: (path: string) => Promise<string | null>;
  getGitRemoteUrl: () => string | null;
  createClient: (baseUrl: string, token: string) => ApiClient;
  io: CliIo;
  /** Test seam for deploy status polling. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Shared runtime for a single command invocation. */
export type CliContext = {
  deps: CliDeps;
  client: ApiClient;
};

export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SPROUT_URL?.trim() || "http://127.0.0.1:7331";
}

/** Well-known default; compose/image set `SPROUT_ADMIN_TOKEN_PATH` explicitly. */
const DEFAULT_ADMIN_TOKEN_PATH = "admin-token";

/**
 * Path for the gateway-persisted bootstrap admin token.
 * CLI does not derive this from the control-plane DB path — publish via
 * `SPROUT_ADMIN_TOKEN_PATH` (compose/Dockerfile set `/data/admin-token`).
 */
export function resolveAdminTokenPath(env: NodeJS.ProcessEnv): string {
  return env.SPROUT_ADMIN_TOKEN_PATH?.trim() || DEFAULT_ADMIN_TOKEN_PATH;
}

/** Loopback hosts where admin env/file fallback is safe. */
export function isLocalGatewayHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function fail(io: CliIo, message: string, code = 1): number {
  io.stderr(message);
  return code;
}

/**
 * Bearer for authed commands (full local-admin policy):
 * 1. `SPROUT_TOKEN` (explicit)
 * 2. on loopback only: `SPROUT_ADMIN_TOKEN`
 * 3. on loopback only: admin token file (`SPROUT_ADMIN_TOKEN_PATH` or default)
 */
export async function requireToken(deps: CliDeps): Promise<Result<string>> {
  const explicit = deps.env.SPROUT_TOKEN?.trim();
  if (explicit) return { ok: true, value: explicit };

  const urlRaw = resolveGatewayUrl(deps.env);
  let hostname: string;
  try {
    hostname = new URL(urlRaw).hostname;
  } catch {
    return { ok: false, error: "invalid SPROUT_URL" };
  }

  if (!isLocalGatewayHostname(hostname)) {
    return { ok: false, error: "SPROUT_TOKEN is required" };
  }

  const admin = deps.env.SPROUT_ADMIN_TOKEN?.trim();
  if (admin) return { ok: true, value: admin };

  const fromFile = await deps.readTextFile(resolveAdminTokenPath(deps.env));
  const fileToken = fromFile?.trim();
  if (fileToken) return { ok: true, value: fileToken };

  return {
    ok: false,
    error: "SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required",
  };
}

export async function loadYaml(deps: CliDeps): Promise<Result<SproutYaml>> {
  const path = `${deps.cwd}/.sprout.yaml`;
  const raw = await deps.readTextFile(path);
  if (raw === null) {
    return { ok: false, error: `missing ${path}` };
  }
  return parseSproutYaml(raw);
}

export async function loadEventPayload(
  deps: CliDeps,
): Promise<Result<unknown | undefined>> {
  const path = deps.env.GITHUB_EVENT_PATH?.trim();
  if (!path) return { ok: true, value: undefined };

  const raw = await deps.readTextFile(path);
  if (raw === null) {
    return {
      ok: false,
      error: `GITHUB_EVENT_PATH not readable: ${path}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      error: `GITHUB_EVENT_PATH is not valid JSON: ${path}`,
    };
  }
}

export function resolveRepo(
  deps: CliDeps,
  override?: string,
): Result<string> {
  if (override?.trim()) {
    const normalized = normalizeGitRemoteUrl(override);
    if (!normalized) {
      return { ok: false, error: "invalid --repo URL" };
    }
    return { ok: true, value: normalized };
  }
  return resolveCanonicalRepoId({
    env: deps.env,
    gitRemoteUrl: deps.getGitRemoteUrl(),
  });
}

export async function resolveIdentity(
  deps: CliDeps,
  overrideRepo?: string,
): Promise<Result<{ repo: string; prId: number }>> {
  const repo = resolveRepo(deps, overrideRepo);
  if (!repo.ok) return repo;

  const event = await loadEventPayload(deps);
  if (!event.ok) return event;

  const prId = resolvePrId({
    env: deps.env,
    eventPayload: event.value,
  });
  if (!prId.ok) return prId;

  return { ok: true, value: { repo: repo.value, prId: prId.value } };
}

export function substituteHostname(template: string, prId: number): string {
  return template.replaceAll("{pr_id}", String(prId));
}

/**
 * CLI-owned hostname substitution: the CLI is the only source the CI reads
 * (via `preview_url=`), so a template that cannot produce a host for this
 * PR fails here instead of reaching the gateway.
 */
export function resolveHostname(
  template: string,
  prId: number,
): Result<string> {
  const resolved = substitutePreviewHostname(template, prId);
  if (!resolved.ok) {
    switch (resolved.issue.code) {
      case "hostname_template_missing_placeholder":
        return {
          ok: false,
          error: `preview.hostname must contain {pr_id} (pr ${prId})`,
        };
      case "hostname_template_invalid":
      case "invalid_hostname":
        return {
          ok: false,
          error: `invalid preview.hostname for pr ${prId}: ${resolved.issue.detail}`,
        };
    }
  }
  return resolved;
}

/**
 * Companion service hostnames may be static or templated: substitute when
 * the template carries `{pr_id}`, otherwise validate the static host.
 */
export function resolveServiceHostname(
  template: string,
  prId: number,
): Result<string> {
  if (!template.includes(HOSTNAME_PLACEHOLDER)) {
    const checked = validateHostname(template);
    if (!checked.ok) {
      const detail =
        checked.issue.code === "invalid_hostname"
          ? checked.issue.detail
          : "invalid hostname";
      return {
        ok: false,
        error: `invalid service hostname for pr ${prId}: ${detail}`,
      };
    }
    return { ok: true, value: template };
  }
  const resolved = resolveHostname(template, prId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error.replace("preview.hostname", "service hostname"),
    };
  }
  return resolved;
}

export async function authedContext(
  deps: CliDeps,
): Promise<Result<CliContext>> {
  const token = await requireToken(deps);
  if (!token.ok) return token;
  return {
    ok: true,
    value: {
      deps,
      client: deps.createClient(resolveGatewayUrl(deps.env), token.value),
    },
  };
}

export function unauthedContext(deps: CliDeps): CliContext {
  return {
    deps,
    client: deps.createClient(resolveGatewayUrl(deps.env), ""),
  };
}
