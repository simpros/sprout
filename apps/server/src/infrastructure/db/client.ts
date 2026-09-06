import { existsSync } from "node:fs";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { relations } from "./relations.ts";

export const DEFAULT_SQLITE_PATH = "sprout.db";
export const LEGACY_SQLITE_PATH = "preview-buddy.db";
export const COMPOSE_DEFAULT_SQLITE_PATH = "/data/sprout.db";
export const COMPOSE_LEGACY_SQLITE_PATH = "/data/preview-buddy.db";

/**
 * Prefer an explicit pin; otherwise open sprout.db if present, else one-release
 * legacy preview-buddy.db (host or /data compose sibling), else create sprout.db.
 * Env equal to the new default still gets the legacy sibling check.
 */
export function resolveStateDbPath(
  envPath: string | undefined = process.env.PB_STATE_DB_PATH,
  exists: (path: string) => boolean = existsSync,
): string {
  const trimmed = envPath?.trim() || undefined;
  if (
    trimmed &&
    trimmed !== DEFAULT_SQLITE_PATH &&
    trimmed !== COMPOSE_DEFAULT_SQLITE_PATH
  ) {
    return trimmed;
  }

  const preferred = trimmed ?? DEFAULT_SQLITE_PATH;
  if (exists(preferred)) return preferred;

  const legacy =
    preferred === COMPOSE_DEFAULT_SQLITE_PATH
      ? COMPOSE_LEGACY_SQLITE_PATH
      : LEGACY_SQLITE_PATH;
  if (exists(legacy)) return legacy;

  return preferred;
}

export function createDrizzle(client: SQL) {
  return drizzle.sqlite({ client, relations });
}

export function connectState(path: string = resolveStateDbPath()) {
  const sql = new SQL(`sqlite://${path}`);
  const db = createDrizzle(sql);
  return { sql, db };
}

export type StateDb = ReturnType<typeof connectState>["db"];
export type StateSql = ReturnType<typeof connectState>["sql"];
