import type { SQL } from "bun";
import { isDuplicateDatabase } from "./pg-errors.ts";

export async function ensureDatabase(
  sql: SQL,
  opts: { name: string; owner: string },
): Promise<void> {
  const existing = await sql`
    SELECT 1 AS ok FROM pg_database WHERE datname = ${opts.name} LIMIT 1
  `;
  if (existing.length > 0) return;
  // Identifiers validated by caller; Bun.sql cannot parameterize DDL identifiers.
  try {
    await sql.unsafe(`CREATE DATABASE ${opts.name} OWNER ${opts.owner}`);
  } catch (err) {
    if (!isDuplicateDatabase(err)) throw err;
  }
}

export async function dropDatabase(sql: SQL, name: string): Promise<void> {
  await sql`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${name} AND pid <> pg_backend_pid()
  `;
  await sql.unsafe(`DROP DATABASE IF EXISTS ${name}`);
}
