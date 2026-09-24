import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

const DB = "sprout_myapp_pr42";
const companion = [
  `PGAPPUSER=${restrictedRoleName(DB)}`,
  `PGAPPPASSWORD=${deriveRestrictedPassword("preview-secret", DB)}`,
];

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

async function setup() {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
  });
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  return postDeployAndSettle(testApp!, token, body);
}

describe("POST /v1/deploy connection env remap", () => {
  test("remaps connection env names on app container create (single omits PGAPP*)", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        env: {
          PGHOST: "DATABASE_HOST",
          PGPORT: "DATABASE_PORT",
          PGUSER: "DATABASE_USER",
          PGPASSWORD: "DATABASE_PASSWORD",
          PGDATABASE: "DATABASE_NAME",
        },
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "DATABASE_HOST=postgres",
      "DATABASE_PORT=5432",
      "DATABASE_USER=sprout_preview",
      "DATABASE_PASSWORD=preview-secret",
      "DATABASE_NAME=sprout_myapp_pr42",
    ]);
    expect(fakePreviewDb!.restrictedEnsured).toEqual([]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      status: "running",
    });
  });

  test("rejects invalid env remap on deploy body", async () => {
    const { deployToken } = await setup();
    const unknown = await postDeploy(
      deployToken,
      deployBody({ env: { REDIS_URL: "REDIS_URL" } }),
    );
    expect(unknown.settleStatus).toBe(422);
    expect(unknown.body).toEqual({ error: "unknown_env_key" });

    const wrongProvider = await postDeploy(
      deployToken,
      deployBody({ env: { DATABASE_URL: "DATABASE_URL" } }),
    );
    expect(wrongProvider.settleStatus).toBe(422);
    expect(wrongProvider.body).toEqual({
      error: "invalid_env_for_provider",
      detail: "preview.env.DATABASE_URL requires db.provider sqlite",
    });

    const sqlitePgKeys = await postDeploy(
      deployToken,
      deployBody({
        env: { PGHOST: "DATABASE_HOST" },
        db: { provider: "sqlite" },
      }),
    );
    expect(sqlitePgKeys.settleStatus).toBe(422);
    expect(sqlitePgKeys.body).toEqual({
      error: "invalid_env_for_provider",
      detail: "preview.env.PGHOST requires db.provider postgres",
    });

    const invalidDb = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "mysql" } }),
    );
    expect(invalidDb.settleStatus).toBe(422);
    expect(invalidDb.body).toEqual({
      error: "invalid_db",
      detail: 'db.provider must be postgres, sqlite or none (got "mysql")',
    });

    const collision = await postDeploy(
      deployToken,
      deployBody({
        env: { PGHOST: "DATABASE_HOST", PGPORT: "DATABASE_HOST" },
      }),
    );
    expect(collision.settleStatus).toBe(422);
    expect(collision.body).toEqual({ error: "env_target_collision" });

    const invalid = await postDeploy(
      deployToken,
      deployBody({ env: { PGHOST: "bad-name" } }),
    );
    expect(invalid.settleStatus).toBe(422);
    expect(invalid.body).toEqual({ error: "invalid_env_target" });

    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });
});

describe("POST /v1/deploy app_env", () => {
  test("injects companion PGAPP* and remaps to APP_DATABASE_*", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        env: {
          PGAPPUSER: "APP_DATABASE_USER",
          PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
        },
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
      `APP_DATABASE_USER=${restrictedRoleName(DB)}`,
      `APP_DATABASE_PASSWORD=${deriveRestrictedPassword("preview-secret", DB)}`,
    ]);
    expect(fakePreviewDb!.restrictedEnsured).toContain(DB);
  });

  test("injects app_env with colliding connection keys stripped (single)", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        app_env: [
          "BETTER_AUTH_SECRET=sekrit",
          "PGHOST=attacker",
          "APP_URL=https://pr-42.example.com",
        ],
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "BETTER_AUTH_SECRET=sekrit",
      "APP_URL=https://pr-42.example.com",
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
    ]);
    expect(fakePreviewDb!.restrictedEnsured).toEqual([]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({ status: "running", slug: "myapp" });
  });

  test("rejects invalid and oversized app_env", async () => {
    const { deployToken } = await setup();
    const invalid = await postDeploy(
      deployToken,
      deployBody({ app_env: ["=novalue", "OK=1"] }),
    );
    expect(invalid.settleStatus).toBe(422);
    expect(invalid.body).toEqual({ error: "invalid_app_env" });

    const tooMany = await postDeploy(
      deployToken,
      deployBody({
        app_env: Array.from({ length: 33 }, (_, i) => `K${i}=v`),
      }),
    );
    expect(tooMany.settleStatus).toBe(422);
    expect(tooMany.body).toEqual({ error: "too_many_app_env" });

    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });
});

describe("POST /v1/deploy db.roles", () => {
  test("explicit dual without remap injects canonical PGAPP*", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "postgres", roles: "dual" } }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
      ...companion,
    ]);
    expect(fakePreviewDb!.restrictedEnsured).toContain(DB);
  });

  test("explicit single omits PGAPP* and skips the companion role", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "postgres", roles: "single" } }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
    ]);
    expect(fakePreviewDb!.restrictedEnsured).toEqual([]);
  });

  test("explicit single plus a companion remap fails naming both sides", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "postgres", roles: "single" },
        env: { PGAPPUSER: "APP_DATABASE_USER" },
      }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({
      error: "invalid_db_roles",
      detail:
        "preview.env.PGAPPUSER conflicts with db.roles single (remove the remap or use db.roles dual)",
    });
    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });

  test("db.roles on sqlite and none is rejected like an out-of-scope env key", async () => {
    const { deployToken } = await setup();
    const sqlite = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "sqlite", roles: "dual" } }),
    );
    expect(sqlite.settleStatus).toBe(422);
    expect(sqlite.body).toEqual({
      error: "invalid_db",
      detail: 'db.roles requires db.provider postgres (got "sqlite")',
    });

    const none = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none", roles: "single" } }),
    );
    expect(none.settleStatus).toBe(422);
    expect(none.body).toEqual({
      error: "invalid_db",
      detail: 'db.roles requires db.provider postgres (got "none")',
    });

    const invalid = await postDeploy(
      deployToken,
      deployBody({ db: { roles: "triple" } }),
    );
    expect(invalid.settleStatus).toBe(422);
    expect(invalid.body).toEqual({
      error: "invalid_db",
      detail: 'db.roles must be single or dual (got "triple")',
    });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("single allows a longer slug up to PG_IDENT_MAX", async () => {
    const { deployToken } = await setup();
    const longSlug = `a${"b".repeat(48)}`;
    const res = await postDeploy(
      deployToken,
      deployBody({
        slug: longSlug,
        hostname: "pr-42.myapp.preview.example.com",
        db: { provider: "postgres", roles: "single" },
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
  });

  test("dual still rejects the same long slug on the companion budget", async () => {
    const { deployToken } = await setup();
    const longSlug = `a${"b".repeat(48)}`;
    const res = await postDeploy(
      deployToken,
      deployBody({
        slug: longSlug,
        hostname: "pr-42.myapp.preview.example.com",
        db: { provider: "postgres", roles: "dual" },
      }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "invalid_slug" });
  });

  test("companion service shares the resolved mode with the app", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup();
    fakeDocker!.exposedPorts.set(SVC, 4000);
    const dual = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "postgres", roles: "dual" },
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(dual.settleStatus).toBe(200);
    const dualSvc = fakeDocker!.creates.find((c) =>
      c.name.endsWith("-svc-api"),
    )!;
    expect(dualSvc.env).toContain(`PGAPPUSER=${restrictedRoleName(DB)}`);
    expect(dualSvc.env).toContain(
      `PGAPPPASSWORD=${deriveRestrictedPassword("preview-secret", DB)}`,
    );
  });

  test("single companion service omits PGAPP* like the app", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup();
    fakeDocker!.exposedPorts.set(SVC, 4000);
    const res = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(res.settleStatus).toBe(200);
    const svc = fakeDocker!.creates.find((c) => c.name.endsWith("-svc-api"))!;
    expect(svc.env).not.toContain(`PGAPPUSER=${restrictedRoleName(DB)}`);
    expect(svc.env.some((e) => e.startsWith("PGAPPUSER="))).toBe(false);
    expect(svc.env.some((e) => e.startsWith("PGAPPPASSWORD="))).toBe(false);
  });
});
