import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAdminToken } from "../auth/store.ts";
import {
  bindPreviewOps,
  type BindPreviewOpsDeps,
  type PreviewAppOps,
} from "../app-deployment/ops.ts";
import type { HealthClock, HealthProbe } from "../app-deployment/health.ts";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { connectState, type StateDb } from "../infrastructure/db/client.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import { runMigrations } from "../scripts/migrate.ts";
import { createRoutes } from "./routes.ts";

export type TestDb = {
  db: StateDb;
  cleanup: () => Promise<void>;
};

export type TestApp = {
  app: ReturnType<typeof createRoutes>;
  db: StateDb;
  adminToken: string;
  previewDb: PreviewDb;
  docker: FakeDockerClient | PreviewDocker;
  cleanup: () => Promise<void>;
};

const defaultOpsDeps: Omit<BindPreviewOpsDeps, "docker"> = {
  pg: {
    host: "postgres",
    port: 5432,
    user: "sprout_preview",
    password: "preview-secret",
  },
  networks: {
    traefik: "sprout-traefik",
    postgres: "sprout-postgres",
  },
  previewPortDefault: 8080,
  seedTimeoutMs: 180_000,
};

export function bindTestPreviewApp(
  docker: PreviewDocker,
  opsDeps?: Partial<Omit<BindPreviewOpsDeps, "docker">>,
): PreviewAppOps {
  return bindPreviewOps({
    docker,
    ...defaultOpsDeps,
    ...opsDeps,
  });
}

export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "sprout-auth-"));
  const { sql, db } = connectState(join(dir, "state.db"));
  await runMigrations(sql);
  return {
    db,
    cleanup: async () => {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const defaultHealthProbe: HealthProbe = {
  async getStatus() {
    return 200;
  },
};

export async function createTestApp(
  options:
    | {
        adminToken?: string;
        previewDb?: PreviewDb;
        docker?: PreviewDocker;
        replaceDeps?: Partial<Omit<BindPreviewOpsDeps, "docker">>;
        healthProbe?: HealthProbe;
        healthClock?: HealthClock;
      }
    | string = {},
): Promise<TestApp> {
  const opts =
    typeof options === "string" ? { adminToken: options } : options;
  const adminToken = opts.adminToken ?? "test-admin-token";
  const previewDb = opts.previewDb ?? createFakePreviewDb();
  const docker = opts.docker ?? createFakeDockerClient();
  const appOps = bindTestPreviewApp(docker, {
    ...opts.replaceDeps,
    healthProbe: opts.healthProbe ?? defaultHealthProbe,
    healthClock: opts.healthClock,
  });
  const { db, cleanup } = await createTestDb();
  await ensureAdminToken(db, adminToken);
  return {
    app: createRoutes({
      db,
      previewDb,
      app: appOps,
    }),
    db,
    adminToken,
    previewDb,
    docker,
    cleanup,
  };
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export const TEST_REPO = "https://github.com/org/repo";
export const TEST_APP_IMAGE = "ghcr.io/org/myapp:sha-abc";
export const TEST_HOSTNAME = "pr-42.myapp.preview.example.com";

export function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: TEST_REPO,
    pr_id: 42,
    slug: "myapp",
    hostname: TEST_HOSTNAME,
    app_image: TEST_APP_IMAGE,
    ...overrides,
  };
}

export async function postDeployToken(
  app: TestApp,
  body: { canonical_repo_id: string; slug: string },
) {
  const res = await app.app.handle(
    new Request("http://localhost/v1/admin/tokens", {
      method: "POST",
      headers: {
        ...bearer(app.adminToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

function snapshotDeployOutcome(
  data: Record<string, unknown>,
): "ready" | "failed" | "pending" {
  if (typeof data.last_error === "string") return "failed";
  if (data.status === "failed") return "failed";
  if (
    data.status === "running" &&
    typeof data.preview_url === "string" &&
    data.preview_url.length > 0
  ) {
    return "ready";
  }
  return "pending";
}

export async function postDeployAndSettle(
  app: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{
  acceptStatus: number;
  settleStatus: number;
  outcome: "ready" | "failed" | "rejected";
  body: Record<string, unknown>;
}> {
  const res = await app.app.handle(
    new Request("http://localhost/v1/deploy", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const acceptStatus = res.status;
  const json: unknown = await res.json();
  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : { value };
  if (acceptStatus !== 202) {
    return {
      acceptStatus,
      settleStatus: acceptStatus,
      outcome: "rejected",
      body: asRecord(json),
    };
  }

  const repo = String(body.canonical_repo_id);
  const prId = Number(body.pr_id);

  for (let i = 0; i < 500; i++) {
    const poll = await app.app.handle(
      new Request(
        `http://localhost/v1/preview?canonical_repo_id=${encodeURIComponent(repo)}&pr_id=${prId}`,
        { headers: bearer(token) },
      ),
    );
    const pollBody = asRecord(await poll.json());
    if (poll.status === 200) {
      const outcome = snapshotDeployOutcome(pollBody);
      if (outcome === "ready") {
        return {
          acceptStatus,
          settleStatus: 200,
          outcome,
          body: pollBody,
        };
      }
      if (outcome === "failed") {
        return {
          acceptStatus,
          settleStatus: acceptStatus,
          outcome,
          body: pollBody,
        };
      }
    } else if (poll.status >= 400) {
      return {
        acceptStatus,
        settleStatus: poll.status,
        outcome: "rejected",
        body: pollBody,
      };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `deploy did not settle for ${repo} pr=${prId}; last=${JSON.stringify(json)}`,
  );
}

export type { FakeDockerClient };
