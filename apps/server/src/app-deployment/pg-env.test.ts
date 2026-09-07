import { describe, expect, test } from "bun:test";
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

describe("withGatewayConnectionEnv", () => {
  const gateway = pgConnectionEnv(pg, "prev_myapp_pr42");

  test("strips colliding PG* and keeps non-colliding keys", () => {
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "PGHOST=attacker"],
        gateway,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...gateway]);
  });

  test("strips remapped target names under full remap", () => {
    const remapped = pgConnectionEnv(pg, "prev_myapp_pr42", {
      PGHOST: "DATABASE_HOST",
      PGPORT: "DATABASE_PORT",
      PGUSER: "DATABASE_USER",
      PGPASSWORD: "DATABASE_PASSWORD",
      PGDATABASE: "DATABASE_NAME",
    });
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "DATABASE_HOST=attacker"],
        remapped,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...remapped]);
  });

  test("partial remap strips remapped target and remapped-away PG*", () => {
    const partial = pgConnectionEnv(pg, "prev_myapp_pr42", {
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
