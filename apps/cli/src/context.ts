import type { ApiClient } from "@sprout/api-client";
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

export function fail(io: CliIo, message: string, code = 1): number {
  io.stderr(message);
  return code;
}

export function requireToken(deps: CliDeps): string | null {
  const token = deps.env.SPROUT_TOKEN?.trim();
  return token || null;
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

export function authedContext(
  deps: CliDeps,
): Result<CliContext> {
  const token = requireToken(deps);
  if (!token) {
    return { ok: false, error: "SPROUT_TOKEN is required" };
  }
  return {
    ok: true,
    value: {
      deps,
      client: deps.createClient(resolveGatewayUrl(deps.env), token),
    },
  };
}

export function unauthedContext(deps: CliDeps): CliContext {
  return {
    deps,
    client: deps.createClient(resolveGatewayUrl(deps.env), ""),
  };
}
