import { describe, expect, test } from "bun:test";
import {
  pgConnectionEnv,
  resolvePreviewEnv,
  type AppDeployPg,
} from "./pg-env.ts";

const pg: AppDeployPg = {
  host: "postgres",
  port: 5432,
  user: "pb_preview",
  password: "sekrit",
};

describe("pgConnectionEnv", () => {
  test("absent remap emits exactly the five PG* names", () => {
    expect(pgConnectionEnv(pg, "prev_myapp_pr42")).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
    ]);
  });

  test("full remap replaces names (no dual alias)", () => {
    expect(
      pgConnectionEnv(pg, "prev_myapp_pr42", {
        PGHOST: "DATABASE_HOST",
        PGPORT: "DATABASE_PORT",
        PGUSER: "DATABASE_USER",
        PGPASSWORD: "DATABASE_PASSWORD",
        PGDATABASE: "DATABASE_NAME",
      }),
    ).toEqual([
      "DATABASE_HOST=postgres",
      "DATABASE_PORT=5432",
      "DATABASE_USER=pb_preview",
      "DATABASE_PASSWORD=sekrit",
      "DATABASE_NAME=prev_myapp_pr42",
    ]);
  });

  test("partial remap keeps unmapped keys as PG*", () => {
    expect(
      pgConnectionEnv(pg, "prev_myapp_pr42", {
        PGHOST: "DATABASE_HOST",
        PGUSER: "DATABASE_USER",
      }),
    ).toEqual([
      "DATABASE_HOST=postgres",
      "PGPORT=5432",
      "DATABASE_USER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
    ]);
  });

  test("identity map still emits PG* names", () => {
    expect(
      pgConnectionEnv(pg, "prev_myapp_pr42", { PGHOST: "PGHOST" }),
    ).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
    ]);
  });
});

describe("resolvePreviewEnv", () => {
  test("absent or empty map means no remapping", () => {
    expect(resolvePreviewEnv(undefined)).toEqual({ ok: true, value: undefined });
    expect(resolvePreviewEnv({})).toEqual({ ok: true, value: undefined });
  });

  test("accepts identity and partial maps", () => {
    expect(
      resolvePreviewEnv({ PGHOST: "PGHOST", PGUSER: "DATABASE_USER" }),
    ).toEqual({
      ok: true,
      value: { PGHOST: "PGHOST", PGUSER: "DATABASE_USER" },
    });
  });

  test("rejects unknown keys", () => {
    expect(resolvePreviewEnv({ DATABASE_URL: "DATABASE_URL" })).toEqual({
      ok: false,
      error: "unknown_env_key",
    });
  });

  test("rejects empty or invalid targets", () => {
    expect(resolvePreviewEnv({ PGHOST: "" })).toEqual({
      ok: false,
      error: "invalid_env_target",
    });
    expect(resolvePreviewEnv({ PGHOST: "bad-name" })).toEqual({
      ok: false,
      error: "invalid_env_target",
    });
  });

  test("rejects target collisions", () => {
    expect(
      resolvePreviewEnv({
        PGHOST: "DATABASE_HOST",
        PGPORT: "DATABASE_HOST",
      }),
    ).toEqual({
      ok: false,
      error: "env_target_collision",
    });
  });
});
