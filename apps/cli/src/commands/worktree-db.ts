import {
  dropWorktreeDb,
  provisionWorktreeDb,
  type WorktreeConnection,
} from "@sprout/server/preview-db/worktree";
import type { CliDeps } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import {
  mergeConnectionEnvFile,
  parseEnvRenames,
  resolveEnvKeyNames,
  type ConnectionEnvValues,
} from "../worktree-db/env-file.ts";

export type WorktreeDbDeps = {
  provision: typeof provisionWorktreeDb;
  drop: typeof dropWorktreeDb;
  writeTextFile: (path: string, contents: string) => Promise<void>;
};

const defaultWorktreeDeps: WorktreeDbDeps = {
  provision: provisionWorktreeDb,
  drop: dropWorktreeDb,
  writeTextFile: async (path, contents) => {
    await Bun.write(path, contents);
  },
};

function connectionValues(conn: WorktreeConnection): ConnectionEnvValues {
  return {
    databaseUrl: conn.databaseUrl,
    host: conn.host,
    port: conn.port,
    user: conn.objectName,
    password: conn.password,
    database: conn.objectName,
  };
}

export async function runWorktreeDb(
  tokens: string[],
  deps: CliDeps,
  worktreeDeps: WorktreeDbDeps = defaultWorktreeDeps,
): Promise<number> {
  const [action, ...rest] = tokens;
  if (action === "provision") {
    return runProvision(rest, deps, worktreeDeps);
  }
  if (action === "drop") {
    return runDrop(rest, deps, worktreeDeps);
  }
  return fail(
    deps.io,
    "usage: sprout worktree-db <provision|drop> --slug <name> --admin-url <dsn> …",
  );
}

async function runProvision(
  tokens: string[],
  deps: CliDeps,
  worktreeDeps: WorktreeDbDeps,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "--slug",
    "--env-file",
    "--admin-url",
    "--rename",
  ]);
  if (!flags.ok) return fail(deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      deps.io,
      "usage: sprout worktree-db provision --slug <name> --env-file <path> --admin-url <dsn> [--rename LOGICAL=NAME]",
    );
  }

  const slug = flags.value.slug?.trim();
  const envFile = flags.value.envFile?.trim();
  const adminUrl = flags.value.adminUrl?.trim();
  if (!slug || !envFile || !adminUrl) {
    return fail(
      deps.io,
      "usage: sprout worktree-db provision --slug <name> --env-file <path> --admin-url <dsn> [--rename LOGICAL=NAME]",
    );
  }

  const renames = parseEnvRenames(flags.value.rename);
  if (!renames.ok) return fail(deps.io, renames.error);
  const names = resolveEnvKeyNames(renames.value);

  let conn: WorktreeConnection;
  try {
    conn = await worktreeDeps.provision({ adminUrl, slug });
  } catch (err) {
    return fail(deps.io, err instanceof Error ? err.message : String(err));
  }

  const existing = await deps.readTextFile(envFile);
  const body = mergeConnectionEnvFile(existing, connectionValues(conn), names);
  try {
    await worktreeDeps.writeTextFile(envFile, body);
  } catch (err) {
    return fail(deps.io, err instanceof Error ? err.message : String(err));
  }

  deps.io.stdout(
    JSON.stringify(
      {
        ok: true,
        slug: conn.slug,
        object_name: conn.objectName,
        env_file: envFile,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function runDrop(
  tokens: string[],
  deps: CliDeps,
  worktreeDeps: WorktreeDbDeps,
): Promise<number> {
  const flags = parseFlags(tokens, ["--slug", "--admin-url"]);
  if (!flags.ok) return fail(deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      deps.io,
      "usage: sprout worktree-db drop --slug <name> --admin-url <dsn>",
    );
  }

  const slug = flags.value.slug?.trim();
  const adminUrl = flags.value.adminUrl?.trim();
  if (!slug || !adminUrl) {
    return fail(
      deps.io,
      "usage: sprout worktree-db drop --slug <name> --admin-url <dsn>",
    );
  }

  try {
    await worktreeDeps.drop({ adminUrl, slug });
  } catch (err) {
    return fail(deps.io, err instanceof Error ? err.message : String(err));
  }

  deps.io.stdout(JSON.stringify({ ok: true, slug }, null, 2));
  return 0;
}
