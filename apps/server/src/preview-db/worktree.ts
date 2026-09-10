import { SQL } from "bun";
import { ensureLoginRole } from "./ensure-role.ts";
import {
  assertWorktreeObjectName,
  normalizeWorktreeSlug,
  worktreeObjectName,
} from "./worktree-names.ts";

function pgErrorMatches(
  err: unknown,
  opts: { codes: string[]; messageRe?: RegExp },
): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (opts.codes.includes(code)) return true;
  if (!opts.messageRe) return false;
  const message = "message" in err ? String(err.message) : String(err);
  return opts.messageRe.test(message);
}

function isDuplicateDatabase(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42P04"],
    messageRe: /already exists/i,
  });
}

function parseAdminUrl(adminUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error(`invalid --admin-url: ${adminUrl}`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error(`invalid --admin-url (missing host): ${adminUrl}`);
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid --admin-url port: ${adminUrl}`);
  }
  return { host, port };
}

function resolveObjectName(rawSlug: string): {
  slug: string;
  objectName: string;
} {
  const slug = normalizeWorktreeSlug(rawSlug);
  if (!slug) {
    throw new Error(`invalid --slug (empty after normalize): ${rawSlug}`);
  }
  const objectName = worktreeObjectName(slug);
  assertWorktreeObjectName(objectName);
  return { slug, objectName };
}

export type WorktreeConnection = {
  slug: string;
  /** Database and login role name (`sprout_wt_…`). */
  objectName: string;
  password: string;
  host: string;
  port: number;
  databaseUrl: string;
};

export type ProvisionWorktreeDbOptions = {
  adminUrl: string;
  slug: string;
  /** When omitted, a random password is generated (synced via ensure-role). */
  password?: string;
};

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Idempotent ensure of worktree DB + LOGIN role (`sprout_wt_<slug>`).
 * Reuses #71 ensure-role (CREATE or ALTER password).
 */
export async function provisionWorktreeDb(
  options: ProvisionWorktreeDbOptions,
): Promise<WorktreeConnection> {
  const { slug, objectName } = resolveObjectName(options.slug);
  const { host, port } = parseAdminUrl(options.adminUrl);
  const password = options.password ?? randomPassword();

  const sql = new SQL(options.adminUrl);
  try {
    await ensureLoginRole(sql, objectName, password);

    const existing = await sql`
      SELECT 1 AS ok FROM pg_database WHERE datname = ${objectName} LIMIT 1
    `;
    if (existing.length === 0) {
      try {
        await sql.unsafe(`CREATE DATABASE ${objectName} OWNER ${objectName}`);
      } catch (err) {
        if (!isDuplicateDatabase(err)) throw err;
      }
    }

    const databaseUrl =
      `postgres://${objectName}:${encodeURIComponent(password)}` +
      `@${host}:${port}/${objectName}`;

    return { slug, objectName, password, host, port, databaseUrl };
  } finally {
    await sql.close();
  }
}

export type DropWorktreeDbOptions = {
  adminUrl: string;
  slug: string;
};

/**
 * Drop worktree DB + role. Touches only `sprout_wt_`-prefixed objects;
 * refuses anything else via assertWorktreeObjectName.
 */
export async function dropWorktreeDb(
  options: DropWorktreeDbOptions,
): Promise<void> {
  const { objectName } = resolveObjectName(options.slug);
  // Defense in depth: never run DROP on a non-prefixed name.
  assertWorktreeObjectName(objectName);

  const sql = new SQL(options.adminUrl);
  try {
    await sql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${objectName} AND pid <> pg_backend_pid()
    `;
    await sql.unsafe(`DROP DATABASE IF EXISTS ${objectName}`);
    await sql.unsafe(`DROP ROLE IF EXISTS ${objectName}`);
  } finally {
    await sql.close();
  }
}
