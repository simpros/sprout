import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import { createPreviewRuntime } from "./runtime.ts";

const PG = {
  host: "postgres",
  port: 5432,
  user: "sprout_preview",
  password: "sekrit",
};

const NETWORKS = { traefik: "sprout-traefik", postgres: "sprout-postgres" };

const SQLITE_DB = { provider: "sqlite" as const, path: "/data", file: "preview.db" };

function runtime() {
  return createPreviewRuntime({
    pg: PG,
    traefikNetwork: NETWORKS.traefik,
    postgresNetwork: NETWORKS.postgres,
  });
}

describe("preview runtime binding", () => {
  test("postgres connection env matches the legacy PG* layout", () => {
    expect(runtime().connectionEnv(undefined, "sprout_myapp_pr42")).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
      `PGAPPUSER=${restrictedRoleName("sprout_myapp_pr42")}`,
      `PGAPPPASSWORD=${deriveRestrictedPassword("sekrit", "sprout_myapp_pr42")}`,
    ]);
  });

  test("postgres remap still replaces names", () => {
    expect(
      runtime().connectionEnv(undefined, "sprout_myapp_pr42", {
        PGHOST: "DATABASE_HOST",
      })[0],
    ).toBe("DATABASE_HOST=postgres");
  });

  test("postgres uses no volumes and both networks", () => {
    expect(runtime().volumes(undefined, "myapp", 42)).toEqual([]);
    expect(runtime().appNetworks(undefined)).toEqual([
      "sprout-traefik",
      "sprout-postgres",
    ]);
    expect(runtime().seedNetworks(undefined)).toEqual(["sprout-postgres"]);
  });

  test("sqlite injects a single DATABASE_URL and no PG* keys", () => {
    expect(
      runtime().connectionEnv(SQLITE_DB, "sprout_myapp_pr42"),
    ).toEqual(["DATABASE_URL=file:/data/preview.db"]);
  });

  test("sqlite remap replaces the name without a dual alias", () => {
    expect(
      runtime().connectionEnv(SQLITE_DB, "sprout_myapp_pr42", {
        DATABASE_URL: "APP_DATABASE_URL",
      }),
    ).toEqual(["APP_DATABASE_URL=file:/data/preview.db"]);
  });

  test("sqlite honors custom path and file", () => {
    expect(
      runtime().connectionEnv(
        { provider: "sqlite", path: "/sqlite", file: "app.db" },
        "sprout_myapp_pr42",
      ),
    ).toEqual(["DATABASE_URL=file:/sqlite/app.db"]);
  });

  test("sqlite mounts one named volume on the app path", () => {
    expect(runtime().volumes(SQLITE_DB, "myapp", 42)).toEqual([
      "sprout-myapp-pr-42-sqlite:/data",
    ]);
  });

  test("sqlite containers join traefik only; seed reuses it", () => {
    expect(runtime().appNetworks(SQLITE_DB)).toEqual(["sprout-traefik"]);
    expect(runtime().seedNetworks(SQLITE_DB)).toEqual(["sprout-traefik"]);
  });
});
