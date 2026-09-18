import type { ApiClient } from "@sprout/api-client";
import {
  normalizeGitRemoteUrl,
  resolveCanonicalRepoId,
  resolvePrIdAny,
} from "./identity.ts";
import type { Result } from "./result.ts";
import { parseSproutYaml, type SproutYaml } from "./yaml.ts";

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type CommandResult = {
  exitCode: number;
};

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readTextFile: (path: string) => Promise<string | null>;
  getGitRemoteUrl: () => string | null;
  createClient: (baseUrl: string, token: string) => ApiClient;
  io: CliIo;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Inherits process env so DOCKER_HOST / registry auth for dind works unchanged. */
  runCommand?: (
    argv: string[],
    opts: { cwd: string },
  ) => Promise<CommandResult>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  /** The forge token travels in headers only and is never logged. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
};

export type CliContext = {
  deps: CliDeps;
  client: ApiClient;
};

export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SPROUT_URL?.trim() || "http://127.0.0.1:7331";
}

const DEFAULT_ADMIN_TOKEN_PATH = "admin-token";

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

  const prId = resolvePrIdAny({
    env: deps.env,
    eventPayload: event.value,
  });
  if (!prId.ok) return prId;

  return { ok: true, value: { repo: repo.value, prId: prId.value } };
}

export async function authedContext(
  deps: CliDeps,
): Promise<Result<CliContext>> {
  const client = await authedClient(deps);
  if (!client.ok) return client;
  return {
    ok: true,
    value: { deps, client: client.value },
  };
}

export async function authedClient(
  deps: CliDeps,
): Promise<Result<ApiClient>> {
  const token = await requireToken(deps);
  if (!token.ok) return token;
  return {
    ok: true,
    value: deps.createClient(resolveGatewayUrl(deps.env), token.value),
  };
}

export function unauthedContext(deps: CliDeps): CliContext {
  return {
    deps,
    client: deps.createClient(resolveGatewayUrl(deps.env), ""),
  };
}

export async function defaultRunCommand(
  argv: string[],
  opts: { cwd: string },
): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    return { exitCode: await proc.exited };
  } catch {
    return { exitCode: 127 };
  }
}

export async function defaultWriteTextFile(
  path: string,
  content: string,
): Promise<void> {
  await Bun.write(path, content);
}
