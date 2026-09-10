import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  dropWorktreeDb,
  provisionWorktreeDb,
  type WorktreeConnection,
} from "@sprout/preview-db";
import type { CliDeps } from "../context.ts";
import { fail } from "../context.ts";
import {
  mergeConnectionEnvFile,
  parseEnvRenames,
  readEnvFileValue,
  resolveEnvKeyNames,
  type ConnectionEnvValues,
} from "../worktree-db/env-file.ts";
import { parseWorktreeDbFlags } from "../worktree-db/flags.ts";

export type WorktreeDbDeps = {
  provision: typeof provisionWorktreeDb;
  drop: typeof dropWorktreeDb;
  writeTextFile: (path: string, contents: string) => Promise<void>;
};

/** Write via temp file + rename so a crash mid-write does not truncate the target. */
export async function writeTextFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = join(
    dirname(path),
    `.sprout-env-${process.pid}-${Date.now()}.tmp`,
  );
  await Bun.write(tmp, contents);
  await rename(tmp, path);
}

const defaultWorktreeDeps: WorktreeDbDeps = {
  provision: provisionWorktreeDb,
  drop: dropWorktreeDb,
  writeTextFile: writeTextFileAtomic,
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

function mapLibraryError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/\badminUrl\b/g, "--admin-url")
    .replace(/\bworktreeKey\b/g, "--slug");
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
  const flags = parseWorktreeDbFlags(tokens, [
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

  const existing = await deps.readTextFile(envFile);
  // Reuse stored password so re-provision does not rotate live credentials.
  const existingPassword = readEnvFileValue(existing, names.PGPASSWORD);

  let conn: WorktreeConnection;
  try {
    conn = await worktreeDeps.provision({
      adminUrl,
      worktreeKey: slug,
      ...(existingPassword !== undefined
        ? { password: existingPassword }
        : {}),
    });
  } catch (err) {
    return fail(deps.io, mapLibraryError(err));
  }

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
        slug: conn.worktreeKey,
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
  const flags = parseWorktreeDbFlags(tokens, ["--slug", "--admin-url"]);
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
    await worktreeDeps.drop({ adminUrl, worktreeKey: slug });
  } catch (err) {
    return fail(deps.io, mapLibraryError(err));
  }

  deps.io.stdout(JSON.stringify({ ok: true, slug }, null, 2));
  return 0;
}
