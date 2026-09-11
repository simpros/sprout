import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import type { HealthProbe } from "../app-deployment/health.ts";
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

const SEED_IMAGE = "ghcr.io/org/myapp-seed:sha-abc";
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

async function setup(options?: {
  waitResults?: Record<string, { exitCode: number } | "timeout">;
  seedTimeoutMs?: number;
  healthProbe?: HealthProbe;
  healthClock?: { now(): number; sleep(ms: number): Promise<void> };
}) {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
    waitResults: options?.waitResults,
  });
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
    replaceDeps: options?.seedTimeoutMs
      ? { seedTimeoutMs: options.seedTimeoutMs }
      : undefined,
    healthProbe: options?.healthProbe,
    healthClock: options?.healthClock,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

function healthBlock() {
  return {
    path: "/health",
    interval: "1s",
    timeout: "30s",
    expect: 200,
  };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  return postDeployAndSettle(testApp!, token, body);
}

describe("POST /v1/deploy seed image", () => {
  test("requires health block when seed_image is present", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "health_required_for_seed" });
    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });

  test("after-healthy hook: seed starts only after health expect is met", async () => {
    const timeline: string[] = [];
    let attempts = 0;
    let now = 0;
    const { deployToken } = await setup({
      healthProbe: {
        async getStatus() {
          attempts += 1;
          timeline.push(`health:${attempts === 1 ? 503 : 200}`);
          return attempts === 1 ? 503 : 200;
        },
      },
      healthClock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    const originalCreate = fakeDocker!.createAndStart.bind(fakeDocker);
    fakeDocker!.createAndStart = async (spec) => {
      timeline.push(
        spec.name.endsWith("-seed") ? "seed:create" : "app:create",
      );
      return originalCreate(spec);
    };

    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(timeline).toEqual([
      "app:create",
      "health:503",
      "health:200",
      "seed:create",
    ]);
  });

  test("after-healthy hook: seed does not run when health times out", async () => {
    let now = 0;
    const { deployToken } = await setup({
      healthProbe: {
        async getStatus() {
          return 503;
        },
      },
      healthClock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });

    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "health_timeout",
    });
    expect(
      fakeDocker!.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(0);
  });

  test("runs one-shot seed after healthy app; gateway replaces colliding seed_env", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        seed_env: ["FIXTURE_SET=demo", "PGHOST=attacker"],
        seed_arg: ["--reset"],
        health: healthBlock(),
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.preview_url).toBe(
      "https://pr-42.myapp.preview.example.com",
    );

    expect(fakeDocker!.pulls).toEqual([APP_IMAGE, SEED_IMAGE]);
    expect(fakeDocker!.creates).toHaveLength(2);
    const seedCreate = fakeDocker!.creates[1]!;
    expect(seedCreate).toMatchObject({
      name: "sprout-myapp-pr-42-seed",
      image: SEED_IMAGE,
      networkNames: ["sprout-postgres"],
      cmd: ["--reset"],
    });
    expect(seedCreate.env).toEqual([
      "FIXTURE_SET=demo",
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
      ...companion,
    ]);
    expect(seedCreate.labels).toEqual({});
    // Entrypoint must remain unset so the image default runs.
    expect(
      Object.prototype.hasOwnProperty.call(seedCreate, "entrypoint"),
    ).toBe(false);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(row?.seededAt).toMatch(/Z$/);
    expect(row?.containerId).toBe("fake-1");
    expect(fakeDocker!.removed).toContain("sprout-myapp-pr-42-seed");
    expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
  });

  // Remap + merge: app/seed share remapped names; colliding seed_env keys are stripped.
  test("applies the same connection env remap to seed as app", async () => {
    const { deployToken } = await setup();
    const remap = {
      PGHOST: "DATABASE_HOST",
      PGPORT: "DATABASE_PORT",
      PGUSER: "DATABASE_USER",
      PGPASSWORD: "DATABASE_PASSWORD",
      PGDATABASE: "DATABASE_NAME",
    };
    const res = await postDeploy(
      deployToken,
      deployBody({
        env: remap,
        seed_image: SEED_IMAGE,
        seed_env: ["FIXTURE_SET=demo", "DATABASE_HOST=attacker"],
        health: healthBlock(),
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates).toHaveLength(2);
    const expectedConnection = [
      "DATABASE_HOST=postgres",
      "DATABASE_PORT=5432",
      "DATABASE_USER=sprout_preview",
      "DATABASE_PASSWORD=preview-secret",
      "DATABASE_NAME=sprout_myapp_pr42",
      ...companion,
    ];
    expect(fakeDocker!.creates[0]!.env).toEqual(expectedConnection);
    expect(fakeDocker!.creates[1]!.env).toEqual([
      "FIXTURE_SET=demo",
      ...expectedConnection,
    ]);
  });

  test("skips seed on synchronize when seeded_at already set", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(first.settleStatus).toBe(200);
    const createsAfterFirst = fakeDocker!.creates.length;
    const pullsAfterFirst = fakeDocker!.pulls.length;

    const second = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
        app_image: APP_IMAGE,
      }),
    );
    expect(second.settleStatus).toBe(200);
    expect(second.body.status).toBe("running");
    // App replace only — no second seed create.
    expect(fakeDocker!.creates.length).toBe(createsAfterFirst + 1);
    expect(
      fakeDocker!.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(1);
    // Named seed_image always pulls (client should omit it on sync to skip).
    expect(fakeDocker!.pulls.slice(pullsAfterFirst)).toEqual([
      APP_IMAGE,
      SEED_IMAGE,
    ]);
  });

  test("reseed runs seed again when seeded_at set without app replace", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(first.settleStatus).toBe(200);
    const [seeded] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(seeded?.seededAt).toMatch(/Z$/);
    const appCreatesAfterFirst = fakeDocker!.creates.filter(
      (c) => c.name === "sprout-myapp-pr-42",
    ).length;

    const second = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
        reseed: true,
      }),
    );
    expect(second.settleStatus).toBe(200);
    expect(second.body.status).toBe("running");
    // Same image/hostname: seed-only — no second app create.
    expect(
      fakeDocker!.creates.filter((c) => c.name === "sprout-myapp-pr-42"),
    ).toHaveLength(appCreatesAfterFirst);
    expect(
      fakeDocker!.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(2);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.seededAt).toMatch(/Z$/);
    expect(row?.containerId).toBe(seeded?.containerId);
  });

  test("reseed without seed_image is rejected", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ reseed: true, health: healthBlock() }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "seed_image_required_for_reseed" });
  });

  test("failed reseed keeps app, clears seeded_at, resume works", async () => {
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
    const deployToken = body.token as string;

    const first = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE, health: healthBlock() }),
    );
    expect(first.settleStatus).toBe(200);

    fakeDocker.waitResults.set("sprout-myapp-pr-42-seed", { exitCode: 3 });
    const failed = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
        reseed: true,
      }),
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.body).toMatchObject({
      status: "failed",
      last_error: "seed_failed",
    });

    const [failedRow] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(failedRow?.seededAt).toBeNull();
    expect(failedRow?.containerId).toBe("fake-1");
    expect(fakeDocker.running.has("sprout-myapp-pr-42")).toBe(true);

    fakeDocker.waitResults.set("sprout-myapp-pr-42-seed", { exitCode: 0 });
    const resume = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE, health: healthBlock() }),
    );
    expect(resume.settleStatus).toBe(200);
    expect(resume.body.status).toBe("running");
    expect(
      fakeDocker.creates.filter((c) => c.name === "sprout-myapp-pr-42"),
    ).toHaveLength(1);
    expect(
      fakeDocker.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(3);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.seededAt).toMatch(/Z$/);
  });

  test("reseed with app image change replaces container then seeds", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(first.settleStatus).toBe(200);

    const NEW_APP = "ghcr.io/org/myapp:sha-new";
    fakeDocker!.exposedPorts.set(NEW_APP, 3000);
    const second = await postDeploy(
      deployToken,
      deployBody({
        app_image: NEW_APP,
        seed_image: SEED_IMAGE,
        health: healthBlock(),
        reseed: true,
      }),
    );
    expect(second.settleStatus).toBe(200);
    expect(second.body.status).toBe("running");
    expect(
      fakeDocker!.creates.filter((c) => c.name === "sprout-myapp-pr-42"),
    ).toHaveLength(2);
    expect(
      fakeDocker!.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(2);
  });

  test("reseed pull failure keeps seeded_at and restores running", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(first.settleStatus).toBe(200);
    const [seeded] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(seeded?.seededAt).toMatch(/Z$/);

    fakeDocker!.pullImage = async (image: string) => {
      if (image === SEED_IMAGE) {
        throw new Error("seed registry blip");
      }
    };
    const failed = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
        reseed: true,
      }),
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.body).toMatchObject({
      status: "running",
      last_error: "preview_seed_pull_failed",
      last_error_detail: "seed registry blip",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(row?.seededAt).toBe(seeded?.seededAt);
    expect(row?.containerId).toBe(seeded?.containerId);
    expect(
      fakeDocker!.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(1);
  });

  test("seed Docker ops failure marks failed and keeps app container", async () => {
    const { deployToken } = await setup();
    const original = fakeDocker!.createAndStart.bind(fakeDocker);
    fakeDocker!.createAndStart = async (spec) => {
      if (spec.name.endsWith("-seed")) {
        throw new Error("docker create boom");
      }
      return original(spec);
    };

    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "seed_failed",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.seededAt).toBeNull();
    expect(row?.containerId).toBe("fake-1");
    expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
  });

  test("enforces max 16 seed_env and seed_arg", async () => {
    const { deployToken } = await setup();
    const tooManyEnv = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        seed_env: Array.from({ length: 17 }, (_, i) => `K${i}=v`),
        health: healthBlock(),
      }),
    );
    expect(tooManyEnv.settleStatus).toBe(422);
    expect(tooManyEnv.body).toEqual({ error: "too_many_seed_env" });

    const tooManyArg = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        seed_arg: Array.from({ length: 17 }, (_, i) => `a${i}`),
        health: healthBlock(),
      }),
    );
    expect(tooManyArg.settleStatus).toBe(422);
    expect(tooManyArg.body).toEqual({ error: "too_many_seed_arg" });
  });

  test("seed non-zero exit marks failed, keeps app, logs seed:failed", async () => {
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      const { deployToken } = await setup({
        waitResults: { "sprout-myapp-pr-42-seed": { exitCode: 7 } },
      });
      const res = await postDeploy(
        deployToken,
        deployBody({
          seed_image: SEED_IMAGE,
          health: healthBlock(),
        }),
      );
      expect(res.outcome).toBe("failed");
      expect(res.body).toMatchObject({
        status: "failed",
        last_error: "seed_failed",
      });

      const [row] = await testApp!.db
        .select()
        .from(previews)
        .where(
          and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
        )
        .limit(1);
      expect(row?.status).toBe("failed");
      expect(row?.seededAt).toBeNull();
      expect(row?.containerId).toBe("fake-1");
      expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
      expect(warns.some((args) => args[0] === "seed:failed" && args[1] === 7)).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("seed timeout marks failed and logs seed:failed", async () => {
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      const { deployToken } = await setup({
        waitResults: { "sprout-myapp-pr-42-seed": "timeout" },
        seedTimeoutMs: 1,
      });
      const res = await postDeploy(
        deployToken,
        deployBody({
          seed_image: SEED_IMAGE,
          health: healthBlock(),
        }),
      );
      expect(res.outcome).toBe("failed");
      expect(res.body).toMatchObject({
        status: "failed",
        last_error: "seed_failed",
      });
      expect(
        warns.some(
          (args) => args[0] === "seed:failed" && args[1] === "timeout",
        ),
      ).toBe(true);
      expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retries seed after failed-before-running without app replace", async () => {
    fakePreviewDb = createFakePreviewDb();
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
      waitResults: { "sprout-myapp-pr-42-seed": { exitCode: 1 } },
    });
    testApp = await createTestApp({
      previewDb: fakePreviewDb,
      docker: fakeDocker,
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const deployToken = body.token as string;

    const failed = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE, health: healthBlock() }),
    );
    expect(failed.outcome).toBe("failed");

    const appCreatesAfterFail = fakeDocker.creates.filter(
      (c) => c.name === "sprout-myapp-pr-42",
    ).length;
    expect(appCreatesAfterFail).toBe(1);

    fakeDocker.waitResults.set("sprout-myapp-pr-42-seed", { exitCode: 0 });
    const retry = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE, health: healthBlock() }),
    );
    expect(retry.settleStatus).toBe(200);
    expect(retry.body.status).toBe("running");
    // Same image/hostname: seed-only resume — no second app create.
    expect(
      fakeDocker.creates.filter((c) => c.name === "sprout-myapp-pr-42"),
    ).toHaveLength(1);
    expect(
      fakeDocker.creates.filter((c) => c.name.endsWith("-seed")),
    ).toHaveLength(2);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.seededAt).toMatch(/Z$/);
    expect(row?.containerId).toBe("fake-1");
  });

  test("resumes seed when row is stuck in seeding", async () => {
    const { deployToken } = await setup();
    // Simulate crash after seeding write: healthy app row left mid-seed.
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "seeding",
      appImage: APP_IMAGE,
      containerId: "fake-stuck",
      seededAt: null,
    });

    const createsBefore = fakeDocker!.creates.length;
    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body.status).toBe("running");
    // Resume must not replace the app — only run the seed container.
    expect(
      fakeDocker!.creates.slice(createsBefore).map((c) => c.name),
    ).toEqual(["sprout-myapp-pr-42-seed"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(row?.seededAt).toMatch(/Z$/);
    expect(row?.containerId).toBe("fake-stuck");
  });

  test("seed-incomplete resume without seed_image settles failed + last_error", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "seeding",
      appImage: APP_IMAGE,
      containerId: "fake-stuck",
      seededAt: null,
    });

    const res = await postDeploy(
      deployToken,
      deployBody({ health: healthBlock() }),
    );
    expect(res.acceptStatus).toBe(202);
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "seed_image_required_to_resume_seeding",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("seed_image_required_to_resume_seeding");
    expect(row?.containerId).toBe("fake-stuck");
    expect(row?.seededAt).toBeNull();
  });
});
