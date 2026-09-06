import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMPOSE_DEFAULT_SQLITE_PATH,
  COMPOSE_LEGACY_SQLITE_PATH,
  connectState,
  DEFAULT_SQLITE_PATH,
  LEGACY_SQLITE_PATH,
  resolveStateDbPath,
} from "./client.ts";
import { parseUnambiguousUtcMs } from "./instant.ts";
import { apiTokens, previews, repos } from "./schema.ts";
import { runMigrations } from "../../scripts/migrate.ts";

let tmpDir: string;

afterEach(() => {
  setSystemTime();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function sqlitePath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pb-db-"));
  return join(tmpDir, "state.db");
}

/** SQLite strftime `%f` → `ss.sss` with a Z suffix. */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function tableNames(sql: ReturnType<typeof connectState>["sql"]) {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
}

describe("resolveStateDbPath", () => {
  test("honors an explicit non-default pin", () => {
    expect(resolveStateDbPath("/data/preview-buddy.db", () => false)).toBe(
      "/data/preview-buddy.db",
    );
    expect(resolveStateDbPath("/custom/state.db", () => false)).toBe(
      "/custom/state.db",
    );
  });

  test("prefers existing sprout.db over legacy", () => {
    const exists = (path: string) =>
      path === DEFAULT_SQLITE_PATH || path === LEGACY_SQLITE_PATH;
    expect(resolveStateDbPath(undefined, exists)).toBe(DEFAULT_SQLITE_PATH);
  });

  test("falls back to host legacy when sprout.db is missing", () => {
    expect(
      resolveStateDbPath(undefined, (path) => path === LEGACY_SQLITE_PATH),
    ).toBe(LEGACY_SQLITE_PATH);
  });

  test("falls back to compose legacy when default path is missing", () => {
    expect(
      resolveStateDbPath(
        COMPOSE_DEFAULT_SQLITE_PATH,
        (path) => path === COMPOSE_LEGACY_SQLITE_PATH,
      ),
    ).toBe(COMPOSE_LEGACY_SQLITE_PATH);
  });

  test("creates sprout.db when neither file exists", () => {
    expect(resolveStateDbPath(undefined, () => false)).toBe(DEFAULT_SQLITE_PATH);
    expect(resolveStateDbPath(COMPOSE_DEFAULT_SQLITE_PATH, () => false)).toBe(
      COMPOSE_DEFAULT_SQLITE_PATH,
    );
  });
});

describe("connectState", () => {
  test("db handle is schema-aware", async () => {
    const { sql, db } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      expect(await db.select().from(repos)).toEqual([]);
    } finally {
      await sql.close();
    }
  });
});

describe("runMigrations", () => {
  test("creates previews, repos, and api_tokens tables", async () => {
    const { sql } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      expect(await tableNames(sql)).toEqual([
        "__drizzle_migrations",
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });

  test("is idempotent on re-run", async () => {
    const { sql } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      await runMigrations(sql);
      expect(await tableNames(sql)).toEqual([
        "__drizzle_migrations",
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });

  test("fresh migrate defaults are ISO-Z and pass the fail-closed instant gate", async () => {
    setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const { sql, db } = connectState(sqlitePath());
    try {
      await runMigrations(sql);

      await db.insert(repos).values({
        canonicalId: "https://github.com/acme/widgets",
        slug: "widgets",
      });
      await db.insert(apiTokens).values({
        tokenHash: "tok",
        scope: "admin",
      });
      await db.insert(previews).values({
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 1,
        slug: "widgets",
        dbName: "prev_widgets_pr1",
        hostname: "pr-1.example.com",
        status: "running",
      });

      const [repo] = await db.select().from(repos);
      const [token] = await db.select().from(apiTokens);
      const [preview] = await db.select().from(previews);

      expect(repo?.createdAt).toMatch(ISO_Z);
      expect(token?.createdAt).toMatch(ISO_Z);
      expect(preview?.createdAt).toMatch(ISO_Z);
      expect(preview?.updatedAt).toMatch(ISO_Z);

      expect(parseUnambiguousUtcMs(repo!.createdAt)).toBe(
        Date.parse(repo!.createdAt),
      );
      expect(parseUnambiguousUtcMs(preview!.createdAt)).toBe(
        Date.parse(preview!.createdAt),
      );

      // Fail-closed: space-separated legacy forms never become an instant.
      expect(parseUnambiguousUtcMs("2026-09-02 12:00:00")).toBeNull();
      expect(parseUnambiguousUtcMs("not-a-timestamp")).toBeNull();
    } finally {
      await sql.close();
    }
  });
});
