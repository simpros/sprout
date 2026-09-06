import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAdminToken } from "../auth/store.ts";
import {
  bindPreviewApp,
  type PreviewAppOps,
  type ReplacePreviewAppDeps,
} from "../app-deployment/replace.ts";
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

const defaultReplaceDeps: Omit<ReplacePreviewAppDeps, "docker"> = {
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
};

/** Shared bind for HTTP/sweep tests — same PG/network/port bag as createTestApp. */
export function bindTestPreviewApp(
  docker: PreviewDocker,
  replaceDeps?: Partial<Omit<ReplacePreviewAppDeps, "docker">>,
): PreviewAppOps {
  return bindPreviewApp({
    docker,
    ...defaultReplaceDeps,
    ...replaceDeps,
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
        replaceDeps?: Partial<Omit<ReplacePreviewAppDeps, "docker">>;
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

export type { FakeDockerClient };
