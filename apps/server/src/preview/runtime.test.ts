import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  companionRoleName,
} from "@sprout/preview-db";
import { defaultDbSpec, type DbSpec } from "@sprout/preview-env";
import {
  resolvePreviewPlan,
  type PreviewMaterializationCtx,
} from "./runtime.ts";

const PG = {
  host: "postgres",
  port: 5432,
  user: "sprout_preview",
  password: "sekrit",
};

const NETWORKS = { traefik: "sprout-traefik", postgres: "sprout-postgres" };

const SQLITE_DB: DbSpec = {
  provider: "sqlite",
  path: "/data",
  file: "preview.db",
};

function ctx(): PreviewMaterializationCtx {
  return {
    traefikNetwork: NETWORKS.traefik,
    postgres: { pg: PG, network: NETWORKS.postgres },
  };
}

function plan(
  spec: DbSpec = defaultDbSpec(),
  extra?: Partial<Parameters<typeof resolvePreviewPlan>[1]>,
) {
  return resolvePreviewPlan(ctx(), {
    spec,
    dbName: "sprout_myapp_pr42",
    slug: "myapp",
    prId: 42,
    roles: "single",
    ...extra,
  });
}

describe("resolvePreviewPlan", () => {
  test("postgres defaults to single with no companion PGAPP* keys", () => {
    expect(plan().gatewayEnv).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
    ]);
    expect(plan().roles).toBe("single");
  });

  test("postgres explicit dual matches the legacy PG* layout", () => {
    expect(plan(defaultDbSpec(), { roles: "dual" }).gatewayEnv).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
      `PGAPPUSER=${companionRoleName("sprout_myapp_pr42")!}`,
      `PGAPPPASSWORD=${deriveRestrictedPassword("sekrit", "sprout_myapp_pr42")}`,
    ]);
  });

  test("dual with a companion remap applies the remap to companion names", () => {
    const derived = plan(defaultDbSpec(), {
      roles: "dual",
      connectionEnv: { PGAPPUSER: "APP_DATABASE_USER" },
    });
    expect(derived.roles).toBe("dual");
    expect(derived.gatewayEnv).toContain(
      `APP_DATABASE_USER=${companionRoleName("sprout_myapp_pr42")!}`,
    );
  });

  test("explicit dual with companion remap keeps dual", () => {
    const derived = plan(
      { provider: "postgres", path: "/data", file: "preview.db", roles: "dual" },
      { roles: "dual", connectionEnv: { PGAPPUSER: "APP_DATABASE_USER" } },
    );
    expect(derived.roles).toBe("dual");
    expect(derived.gatewayEnv).toContain(
      `APP_DATABASE_USER=${companionRoleName("sprout_myapp_pr42")!}`,
    );
  });

  test("postgres remap still replaces names", () => {
    expect(
      plan(defaultDbSpec(), { connectionEnv: { PGHOST: "DATABASE_HOST" } })
        .gatewayEnv[0],
    ).toBe("DATABASE_HOST=postgres");
  });

  test("postgres uses no volumes and both networks", () => {
    expect(plan()).toMatchObject({
      provider: "postgres",
      volumes: [],
      appNetworks: ["sprout-traefik", "sprout-postgres"],
      seedNetworks: ["sprout-postgres"],
    });
  });

  test("sqlite injects a single DATABASE_URL and no PG* keys", () => {
    expect(plan(SQLITE_DB).gatewayEnv).toEqual([
      "DATABASE_URL=file:/data/preview.db",
    ]);
  });

  test("sqlite remap replaces the name without a dual alias", () => {
    expect(
      plan(SQLITE_DB, { connectionEnv: { DATABASE_URL: "APP_DATABASE_URL" } })
        .gatewayEnv,
    ).toEqual(["APP_DATABASE_URL=file:/data/preview.db"]);
  });

  test("sqlite honors custom path and file", () => {
    expect(
      plan({ provider: "sqlite", path: "/sqlite", file: "app.db" }).gatewayEnv,
    ).toEqual(["DATABASE_URL=file:/sqlite/app.db"]);
  });

  test("sqlite mounts one named volume and joins traefik only", () => {
    expect(plan(SQLITE_DB)).toMatchObject({
      provider: "sqlite",
      volumes: ["sprout-myapp-pr-42-sqlite:/data"],
      appNetworks: ["sprout-traefik"],
      seedNetworks: ["sprout-traefik"],
    });
  });

  test("sqlite resolves without postgres config", () => {
    expect(
      resolvePreviewPlan(
        { traefikNetwork: NETWORKS.traefik },
        {
          spec: SQLITE_DB,
          dbName: "sprout_myapp_pr42",
          slug: "myapp",
          prId: 42,
          roles: "single",
        },
      ),
    ).toEqual({
      provider: "sqlite",
      dbName: "sprout_myapp_pr42",
      roles: "single",
      gatewayEnv: ["DATABASE_URL=file:/data/preview.db"],
      volumes: ["sprout-myapp-pr-42-sqlite:/data"],
      appNetworks: ["sprout-traefik"],
      seedNetworks: ["sprout-traefik"],
    });
  });

  test("postgres without postgres config throws instead of emitting empty networks", () => {
    expect(() =>
      resolvePreviewPlan(
        { traefikNetwork: NETWORKS.traefik },
        {
          spec: defaultDbSpec(),
          dbName: "sprout_myapp_pr42",
          slug: "myapp",
          prId: 42,
          roles: "single",
        },
      ),
    ).toThrow("without postgres config");
  });

  test("none injects no env, mounts no volumes, joins traefik only", () => {
    expect(
      resolvePreviewPlan(ctx(), {
        spec: { provider: "none", path: "/data", file: "preview.db" },
        dbName: null,
        slug: "myapp",
        prId: 42,
        roles: "single",
      }),
    ).toEqual({
      provider: "none",
      dbName: null,
      roles: "single",
      gatewayEnv: [],
      volumes: [],
      appNetworks: ["sprout-traefik"],
      seedNetworks: [],
    });
  });

  test("none resolves without postgres config and ignores connection env", () => {
    expect(
      resolvePreviewPlan(
        { traefikNetwork: NETWORKS.traefik },
        {
          spec: { provider: "none", path: "/data", file: "preview.db" },
          dbName: null,
          slug: "myapp",
          prId: 42,
          roles: "single",
          connectionEnv: undefined,
        },
      ).provider,
    ).toBe("none");
  });

  test("dbName resolves from slug/prId when omitted", () => {
    expect(
      resolvePreviewPlan(ctx(), { spec: defaultDbSpec(), slug: "myapp", prId: 42, roles: "single" })
        .dbName,
    ).toBe("sprout_myapp_pr42");
    expect(
      resolvePreviewPlan(ctx(), { spec: SQLITE_DB, slug: "myapp", prId: 42, roles: "single" })
        .dbName,
    ).toBe("sprout_myapp_pr42");
    expect(
      resolvePreviewPlan(ctx(), {
        spec: { provider: "none", path: "/data", file: "preview.db" },
        slug: "myapp",
        prId: 42,
        roles: "single",
      }).dbName,
    ).toBeNull();
  });
});
