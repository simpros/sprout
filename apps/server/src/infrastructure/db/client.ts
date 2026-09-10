import { SQL } from "bun";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

// Default control-plane SQLite path (override via SPROUT_STATE_DB_PATH).
const DEFAULT_SQLITE_PATH = "sprout.db";

function resolveStateDbPath(): string {
  return process.env.SPROUT_STATE_DB_PATH?.trim() || DEFAULT_SQLITE_PATH;
}

/** Empty relations object still required for Drizzle RC. */
const relations = defineRelations(schema, () => ({}));

export function createDrizzle(client: SQL) {
  return drizzle.sqlite({ client, relations });
}

export function connectState(path: string = resolveStateDbPath()) {
  const sql = new SQL(`sqlite://${path}`);
  const db = createDrizzle(sql);
  return { sql, db };
}

export type StateDb = ReturnType<typeof connectState>["db"];
