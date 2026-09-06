import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";
const APP_IMAGE = "ghcr.io/org/myapp:sha-abc";
const SEED_IMAGE = "ghcr.io/org/myapp-seed:sha-abc";

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
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    slug: "myapp",
    hostname: "pr-42.myapp.preview.example.com",
    app_image: APP_IMAGE,
    ...overrides,
  };
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
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/deploy", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/deploy seed image", () => {
  test("requires health block when seed_image is present", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "health_required_for_seed" });
    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });

  test("runs one-shot seed after healthy app with PG* after user env", async () => {
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
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.preview_url).toBe(
      "https://pr-42.myapp.preview.example.com",
    );

    expect(fakeDocker!.pulls).toEqual([APP_IMAGE, SEED_IMAGE]);
    expect(fakeDocker!.creates).toHaveLength(2);
    const seedCreate = fakeDocker!.creates[1]!;
    expect(seedCreate).toMatchObject({
      name: "pb-myapp-pr-42-seed",
      image: SEED_IMAGE,
      networkNames: ["preview-buddy-postgres"],
      cmd: ["--reset"],
    });
    expect(seedCreate.env).toEqual([
      "FIXTURE_SET=demo",
      "PGHOST=attacker",
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=prev_myapp_pr42",
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
    expect(fakeDocker!.removed).toContain("pb-myapp-pr-42-seed");
    expect(fakeDocker!.running.has("pb-myapp-pr-42")).toBe(true);
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
    expect(first.status).toBe(200);
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
    expect(second.status).toBe(200);
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
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "seed_failed" });

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
    expect(fakeDocker!.running.has("pb-myapp-pr-42")).toBe(true);
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
    expect(tooManyEnv.status).toBe(422);
    expect(tooManyEnv.body).toEqual({ error: "too_many_seed_env" });

    const tooManyArg = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        seed_arg: Array.from({ length: 17 }, (_, i) => `a${i}`),
        health: healthBlock(),
      }),
    );
    expect(tooManyArg.status).toBe(422);
    expect(tooManyArg.body).toEqual({ error: "too_many_seed_arg" });
  });

  test("seed non-zero exit marks failed, keeps app, logs seed:failed", async () => {
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      const { deployToken } = await setup({
        waitResults: { "pb-myapp-pr-42-seed": { exitCode: 7 } },
      });
      const res = await postDeploy(
        deployToken,
        deployBody({
          seed_image: SEED_IMAGE,
          health: healthBlock(),
        }),
      );
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "seed_failed" });

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
      expect(fakeDocker!.running.has("pb-myapp-pr-42")).toBe(true);
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
        waitResults: { "pb-myapp-pr-42-seed": "timeout" },
        seedTimeoutMs: 1,
      });
      const res = await postDeploy(
        deployToken,
        deployBody({
          seed_image: SEED_IMAGE,
          health: healthBlock(),
        }),
      );
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "seed_failed" });
      expect(
        warns.some(
          (args) => args[0] === "seed:failed" && args[1] === "timeout",
        ),
      ).toBe(true);
      expect(fakeDocker!.running.has("pb-myapp-pr-42")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retries seed after failed-before-running", async () => {
    fakePreviewDb = createFakePreviewDb();
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
      waitResults: { "pb-myapp-pr-42-seed": { exitCode: 1 } },
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
    expect(failed.status).toBe(500);

    fakeDocker.waitResults.set("pb-myapp-pr-42-seed", { exitCode: 0 });
    const retry = await postDeploy(
      deployToken,
      deployBody({ seed_image: SEED_IMAGE, health: healthBlock() }),
    );
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("running");

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.seededAt).toMatch(/Z$/);
  });
});
