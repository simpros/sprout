import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { relations } from "./relations.ts";

const DEFAULT_SQLITE_PATH = "sprout.db";

export function resolveStateDbPath(): string {
  return process.env.PB_STATE_DB_PATH?.trim() || DEFAULT_SQLITE_PATH;
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
