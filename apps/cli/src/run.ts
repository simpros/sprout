import { createApiClient, type ApiClient } from "@sprout/api-client";
import { runAdmin } from "./commands/admin.ts";
import { runDeploy } from "./commands/deploy.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runDrop } from "./commands/drop.ts";
import { runHealth } from "./commands/health.ts";
import { runList } from "./commands/list.ts";
import { runLogs } from "./commands/logs.ts";
import { runTeardown } from "./commands/teardown.ts";
import { runWorktreeDb } from "./commands/worktree-db.ts";
import {
  authedContext,
  fail,
  resolveGatewayUrl,
  unauthedContext,
  type CliContext,
  type CliDeps,
  type CliIo,
} from "./context.ts";
import { cliVersion } from "./version.ts";

export type { CliDeps, CliIo };
export { resolveGatewayUrl };

type Command = {
  needsToken: boolean;
  run: (tokens: string[], ctx: CliContext) => Promise<number>;
};

const COMMANDS: Record<string, Command> = {
  health: { needsToken: false, run: runHealth },
  deploy: { needsToken: true, run: runDeploy },
  teardown: { needsToken: true, run: runTeardown },
  list: { needsToken: true, run: runList },
  doctor: { needsToken: true, run: runDoctor },
  drop: { needsToken: true, run: runDrop },
  logs: { needsToken: true, run: runLogs },
  admin: { needsToken: true, run: runAdmin },
  "worktree-db": {
    needsToken: false,
    run: async (tokens, ctx) => runWorktreeDb(tokens, ctx.deps),
  },
};

export async function runCli(
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  const [name = "", ...tokens] = argv;
  if (!name) {
    return fail(
      deps.io,
      "usage: sprout <health|deploy|teardown|list|doctor|drop|logs|admin|worktree-db> …",
    );
  }

  if (name === "--version" || name === "-V") {
    deps.io.stdout(cliVersion());
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    return fail(deps.io, `unknown command: ${name}`);
  }

  if (!command.needsToken) {
    return command.run(tokens, unauthedContext(deps));
  }

  const ctx = await authedContext(deps);
  if (!ctx.ok) return fail(deps.io, ctx.error);
  return command.run(tokens, ctx.value);
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
