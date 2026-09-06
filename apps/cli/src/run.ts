import { createApiClient, type ApiClient } from "@sprout/api-client";
import {
  resolveCanonicalRepoId,
  resolvePrId,
} from "./identity.ts";
import { parseSproutYaml, type SproutYaml } from "./yaml.ts";

export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SPROUT_URL?.trim() || "http://127.0.0.1:7331";
}

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

type ParsedArgs = {
  command: string;
  rest: string[];
  image?: string;
  seedImage?: string;
  seedEnv: string[];
  seedArg: string[];
  yes: boolean;
  repo?: string;
  slug?: string;
  scope?: string;
};

function fail(io: CliIo, message: string, code = 1): number {
  io.stderr(message);
  return code;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [command = "", ...tokens] = argv;
  const out: ParsedArgs = {
    command,
    rest: [],
    seedEnv: [],
    seedArg: [],
    yes: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = (opts?: { allowDash?: boolean }) => {
      const value = tokens[++i];
      if (value === undefined) return null;
      if (!opts?.allowDash && value.startsWith("-")) return null;
      return value;
    };

    switch (token) {
      case "-i": {
        const value = next();
        if (!value) return { error: "deploy requires -i <image>" };
        out.image = value;
        break;
      }
      case "-s": {
        const value = next();
        if (!value) return { error: "missing value for -s" };
        out.seedImage = value;
        break;
      }
      case "--seed-env": {
        const value = next({ allowDash: true });
        if (!value) return { error: "missing value for --seed-env" };
        out.seedEnv.push(value);
        break;
      }
      case "--seed-arg": {
        // Seed args are often flags themselves (e.g. `--reset`).
        const value = next({ allowDash: true });
        if (!value) return { error: "missing value for --seed-arg" };
        out.seedArg.push(value);
        break;
      }
      case "--yes":
        out.yes = true;
        break;
      case "--repo": {
        const value = next();
        if (!value) return { error: "missing value for --repo" };
        out.repo = value;
        break;
      }
      case "--slug": {
        const value = next();
        if (!value) return { error: "missing value for --slug" };
        out.slug = value;
        break;
      }
      case "--scope": {
        const value = next();
        if (!value) return { error: "missing value for --scope" };
        out.scope = value;
        break;
      }
      default:
        if (token.startsWith("-")) {
          return { error: `unknown flag: ${token}` };
        }
        out.rest.push(token);
    }
  }

  return out;
}

async function loadYaml(deps: CliDeps): Promise<
  { ok: true; value: SproutYaml } | { ok: false; error: string }
> {
  const path = `${deps.cwd}/.sprout.yaml`;
  const raw = await deps.readTextFile(path);
  if (raw === null) {
    return { ok: false, error: `missing ${path}` };
  }
  return parseSproutYaml(raw);
}

async function loadEventPayload(deps: CliDeps): Promise<unknown> {
  const path = deps.env.GITHUB_EVENT_PATH?.trim();
  if (!path) return undefined;
  const raw = await deps.readTextFile(path);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function resolveRepo(
  deps: CliDeps,
  override?: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (override?.trim()) {
    return { ok: true, value: override.trim() };
  }
  return resolveCanonicalRepoId({
    env: deps.env,
    gitRemoteUrl: deps.getGitRemoteUrl(),
  });
}

async function resolveIdentity(
  deps: CliDeps,
  overrideRepo?: string,
): Promise<
  | { ok: true; repo: string; prId: number }
  | { ok: false; error: string }
> {
  const repo = await resolveRepo(deps, overrideRepo);
  if (!repo.ok) return repo;
  const prId = resolvePrId({
    env: deps.env,
    eventPayload: await loadEventPayload(deps),
  });
  if (!prId.ok) return prId;
  return { ok: true, repo: repo.value, prId: prId.value };
}

function requireToken(deps: CliDeps): string | null {
  const token = deps.env.SPROUT_TOKEN?.trim();
  return token || null;
}

function substituteHostname(template: string, prId: number): string {
  return template.replaceAll("{pr_id}", String(prId));
}

function apiErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "value" in error &&
    error.value &&
    typeof error.value === "object" &&
    "error" in error.value
  ) {
    return String((error.value as { error: unknown }).error);
  }
  return "request failed";
}

export async function runCli(
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return fail(deps.io, parsed.error);

  const { command } = parsed;
  if (!command) {
    return fail(
      deps.io,
      "usage: sprout <deploy|teardown|list|doctor|drop|admin> …",
    );
  }

  if (command === "health") {
    const client = deps.createClient(resolveGatewayUrl(deps.env), "");
    const response = await client.healthz.get();
    if (response.error) {
      return fail(deps.io, apiErrorMessage(response.error));
    }
    deps.io.stdout(JSON.stringify(response.data));
    return 0;
  }

  const token = requireToken(deps);
  if (!token) {
    return fail(deps.io, "SPROUT_TOKEN is required");
  }

  const client = deps.createClient(resolveGatewayUrl(deps.env), token);

  switch (command) {
    case "deploy":
      return deployCommand(parsed, deps, client);
    case "teardown":
      return teardownCommand(parsed, deps, client);
    case "list":
      return listCommand(deps, client);
    case "doctor":
      return doctorCommand(deps, client);
    case "drop":
      return dropCommand(parsed, deps, client);
    case "admin":
      return adminCommand(parsed, deps, client);
    default:
      return fail(deps.io, `unknown command: ${command}`);
  }
}

async function deployCommand(
  args: ParsedArgs,
  deps: CliDeps,
  client: ApiClient,
): Promise<number> {
  if (!args.image) {
    return fail(deps.io, "deploy requires -i <image>");
  }
  if (args.rest.length > 0) {
    return fail(deps.io, `unexpected arguments: ${args.rest.join(" ")}`);
  }

  const yaml = await loadYaml(deps);
  if (!yaml.ok) return fail(deps.io, yaml.error);

  if (args.seedImage && !yaml.value.health) {
    return fail(
      deps.io,
      "health block required in .sprout.yaml when -s is passed",
    );
  }

  const identity = await resolveIdentity(deps, args.repo);
  if (!identity.ok) return fail(deps.io, identity.error);

  const body: {
    canonical_repo_id: string;
    pr_id: number;
    slug: string;
    hostname: string;
    app_image: string;
    health?: SproutYaml["health"];
    seed_image?: string;
    seed_env?: string[];
    seed_arg?: string[];
  } = {
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
    slug: yaml.value.slug,
    hostname: substituteHostname(yaml.value.preview.hostname, identity.prId),
    app_image: args.image,
  };

  if (yaml.value.health) body.health = yaml.value.health;
  if (args.seedImage) body.seed_image = args.seedImage;
  if (args.seedEnv.length > 0) body.seed_env = args.seedEnv;
  if (args.seedArg.length > 0) body.seed_arg = args.seedArg;

  const response = await client.v1.deploy.post(body);
  if (response.error) {
    return fail(deps.io, apiErrorMessage(response.error));
  }

  const data = response.data as { preview_url?: string; status?: string };
  if (data?.status && data.status !== "running") {
    return fail(deps.io, `deploy ended with status: ${data.status}`);
  }
  if (!data?.preview_url) {
    return fail(deps.io, "deploy succeeded without preview_url");
  }
  deps.io.stdout(`preview_url=${data.preview_url}`);
  return 0;
}

async function teardownCommand(
  args: ParsedArgs,
  deps: CliDeps,
  client: ApiClient,
): Promise<number> {
  if (args.rest.length > 0) {
    return fail(deps.io, `unexpected arguments: ${args.rest.join(" ")}`);
  }
  const identity = await resolveIdentity(deps, args.repo);
  if (!identity.ok) return fail(deps.io, identity.error);

  const response = await client.v1.teardown.post({
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
  });
  if (response.error) {
    return fail(deps.io, apiErrorMessage(response.error));
  }
  return 0;
}

async function listCommand(deps: CliDeps, client: ApiClient): Promise<number> {
  const response = await client.v1.previews.get();
  if (response.error) {
    return fail(deps.io, apiErrorMessage(response.error));
  }
  deps.io.stdout(JSON.stringify(response.data, null, 2));
  return 0;
}

async function doctorCommand(
  deps: CliDeps,
  client: ApiClient,
): Promise<number> {
  const response = await client.v1.doctor.get();
  if (response.error) {
    const value = (
      response.error as { value?: { ok?: boolean; error?: string } }
    ).value;
    deps.io.stdout(JSON.stringify(value ?? response.error, null, 2));
    return fail(deps.io, value?.error ?? "doctor_failed");
  }
  deps.io.stdout(JSON.stringify(response.data, null, 2));
  return 0;
}

async function dropCommand(
  args: ParsedArgs,
  deps: CliDeps,
  client: ApiClient,
): Promise<number> {
  const [prRaw, ...extra] = args.rest;
  if (!prRaw || extra.length > 0) {
    return fail(deps.io, "usage: sprout drop <pr_id> [--yes]");
  }
  const prId = Number(prRaw);
  if (!Number.isInteger(prId) || prId <= 0) {
    return fail(deps.io, "pr_id must be a positive integer");
  }

  const repo = await resolveRepo(deps, args.repo);
  if (!repo.ok) return fail(deps.io, repo.error);

  const response = await client.v1.drop.post({
    canonical_repo_id: repo.value,
    pr_id: prId,
    yes: args.yes || undefined,
  });

  if (response.status === 409) {
    const value = (response.error as { value?: unknown } | null)?.value;
    deps.io.stdout(JSON.stringify(value ?? { error: "confirmation_required" }, null, 2));
    return fail(deps.io, "confirmation required; re-run with --yes", 2);
  }

  if (response.error) {
    return fail(deps.io, apiErrorMessage(response.error));
  }
  deps.io.stdout(JSON.stringify(response.data, null, 2));
  return 0;
}

async function adminCommand(
  args: ParsedArgs,
  deps: CliDeps,
  client: ApiClient,
): Promise<number> {
  const [resource, action, ...extra] = args.rest;
  if (resource !== "token") {
    return fail(
      deps.io,
      "usage: sprout admin token <create|revoke|list> …",
    );
  }

  switch (action) {
    case "list": {
      if (extra.length > 0) {
        return fail(deps.io, "usage: sprout admin token list");
      }
      const response = await client.v1.admin.tokens.get();
      if (response.error) {
        return fail(deps.io, apiErrorMessage(response.error));
      }
      deps.io.stdout(JSON.stringify(response.data, null, 2));
      return 0;
    }
    case "revoke": {
      const [id, ...more] = extra;
      if (!id || more.length > 0) {
        return fail(deps.io, "usage: sprout admin token revoke <id>");
      }
      const response = await client.v1.admin.tokens({ id }).delete();
      if (response.error) {
        return fail(deps.io, apiErrorMessage(response.error));
      }
      deps.io.stdout(JSON.stringify(response.data, null, 2));
      return 0;
    }
    case "create": {
      if (extra.length > 0) {
        return fail(
          deps.io,
          "usage: sprout admin token create --repo <url> [--slug <slug>] [--scope deploy]",
        );
      }
      if (args.scope && args.scope !== "deploy") {
        return fail(deps.io, "only --scope deploy is supported");
      }
      const repo = await resolveRepo(deps, args.repo);
      if (!repo.ok) {
        return fail(deps.io, args.repo ? repo.error : "--repo is required");
      }
      if (!args.repo) {
        return fail(deps.io, "--repo is required");
      }

      let slug = args.slug?.trim();
      if (!slug) {
        const yaml = await loadYaml(deps);
        if (!yaml.ok) {
          return fail(deps.io, "--slug is required (or provide .sprout.yaml)");
        }
        slug = yaml.value.slug;
      }

      const response = await client.v1.admin.tokens.post({
        canonical_repo_id: repo.value,
        slug,
      });
      if (response.error) {
        return fail(deps.io, apiErrorMessage(response.error));
      }
      deps.io.stdout(JSON.stringify(response.data, null, 2));
      return 0;
    }
    default:
      return fail(
        deps.io,
        "usage: sprout admin token <create|revoke|list> …",
      );
  }
}

export function createDefaultClient(
  baseUrl: string,
  token: string,
): ApiClient {
  return createApiClient(baseUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export function readGitRemoteUrl(): string | null {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  return text || null;
}

export async function readTextFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}
