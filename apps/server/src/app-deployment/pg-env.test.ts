import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import {
  pgConnectionEnv,
  withGatewayConnectionEnv,
  type AppDeployPg,
} from "./pg-env.ts";

const pg: AppDeployPg = {
  host: "postgres",
  port: 5432,
  user: "pb_preview",
  password: "sekrit",
};

const dbName = "prev_myapp_pr42";
const appUser = restrictedRoleName(dbName);
const appPassword = deriveRestrictedPassword(pg.password, dbName);

describe("pgConnectionEnv", () => {
  test("absent remap emits owner PG* plus companion PGAPP*", () => {
    expect(pgConnectionEnv(pg, dbName)).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
      `PGAPPUSER=${appUser}`,
      `PGAPPPASSWORD=${appPassword}`,
    ]);
  });

  test("full remap replaces names (no dual alias)", () => {
    expect(
      pgConnectionEnv(pg, dbName, {
        PGHOST: "DATABASE_HOST",
        PGPORT: "DATABASE_PORT",
        PGUSER: "DATABASE_USER",
        PGPASSWORD: "DATABASE_PASSWORD",
        PGDATABASE: "DATABASE_NAME",
        PGAPPUSER: "APP_DATABASE_USER",
        PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
      }),
    ).toEqual([
      "DATABASE_HOST=postgres",
      "DATABASE_PORT=5432",
      "DATABASE_USER=pb_preview",
      "DATABASE_PASSWORD=sekrit",
      "DATABASE_NAME=prev_myapp_pr42",
      `APP_DATABASE_USER=${appUser}`,
      `APP_DATABASE_PASSWORD=${appPassword}`,
    ]);
  });

  test("partial remap keeps unmapped keys as canonical", () => {
    expect(
      pgConnectionEnv(pg, dbName, {
        PGHOST: "DATABASE_HOST",
        PGUSER: "DATABASE_USER",
      }),
    ).toEqual([
      "DATABASE_HOST=postgres",
      "PGPORT=5432",
      "DATABASE_USER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
      `PGAPPUSER=${appUser}`,
      `PGAPPPASSWORD=${appPassword}`,
    ]);
  });

  test("identity map still emits canonical names", () => {
    expect(
      pgConnectionEnv(pg, dbName, { PGHOST: "PGHOST" }),
    ).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
      `PGAPPUSER=${appUser}`,
      `PGAPPPASSWORD=${appPassword}`,
    ]);
  });
});

describe("withGatewayConnectionEnv", () => {
  const gateway = pgConnectionEnv(pg, dbName);

  test("strips colliding PG* and keeps non-colliding keys", () => {
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "PGHOST=attacker"],
        gateway,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...gateway]);
  });

  test("strips remapped target names under full remap", () => {
    const remapped = pgConnectionEnv(pg, dbName, {
      PGHOST: "DATABASE_HOST",
      PGPORT: "DATABASE_PORT",
      PGUSER: "DATABASE_USER",
      PGPASSWORD: "DATABASE_PASSWORD",
      PGDATABASE: "DATABASE_NAME",
      PGAPPUSER: "APP_DATABASE_USER",
      PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
    });
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "DATABASE_HOST=attacker", "APP_DATABASE_PASSWORD=x"],
        remapped,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...remapped]);
  });

  test("partial remap strips remapped target and remapped-away PG*", () => {
    const partial = pgConnectionEnv(pg, dbName, {
      PGHOST: "DATABASE_HOST",
    });
    expect(
      withGatewayConnectionEnv(
        [
          "FIXTURE_SET=demo",
          "DATABASE_HOST=attacker",
          "PGUSER=evil",
          "PGHOST=leftover",
        ],
        partial,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...partial]);
  });
});
