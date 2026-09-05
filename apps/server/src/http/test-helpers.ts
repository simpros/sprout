import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAdminToken } from "../auth/store.ts";
import {
  bindPreviewApp,
  type PreviewAppOps,
  type ReplacePreviewAppDeps,
} from "../app-deployment/replace.ts";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { connectState, type StateDb } from "../infrastructure/db/client.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import {
  createFakeContainers,
  type FakeContainers,
} from "../preview/fake.ts";
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
  docker: PreviewDocker;
  containers: FakeContainers;
  cleanup: () => Promise<void>;
};

const defaultReplaceDeps: Omit<ReplacePreviewAppDeps, "docker"> = {
  pg: {
    host: "postgres",
    port: 5432,
    user: "pb_preview",
    password: "preview-secret",
  },
  networks: {
    traefik: "preview-buddy-traefik",
    postgres: "preview-buddy-postgres",
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
  const dir = mkdtempSync(join(tmpdir(), "pb-auth-"));
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

export async function createTestApp(
  options:
    | {
        adminToken?: string;
        previewDb?: PreviewDb;
        docker?: PreviewDocker;
        containers?: FakeContainers;
        replaceDeps?: Partial<Omit<ReplacePreviewAppDeps, "docker">>;
      }
    | string = {},
): Promise<TestApp> {
  const opts =
    typeof options === "string" ? { adminToken: options } : options;
  const adminToken = opts.adminToken ?? "test-admin-token";
  const previewDb = opts.previewDb ?? createFakePreviewDb();
  const docker = opts.docker ?? createFakeDockerClient();
  const containers = opts.containers ?? createFakeContainers();
  const appOps = bindTestPreviewApp(docker, opts.replaceDeps);
  const { db, cleanup } = await createTestDb();
  await ensureAdminToken(db, adminToken);
  return {
    app: createRoutes({ db, previewDb, app: appOps, containers }),
    db,
    adminToken,
    previewDb,
    docker,
    containers,
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