import { bindPreviewOps } from "./app-deployment/ops.ts";
import { bootstrapAdminToken } from "./auth/bootstrap-admin.ts";
import {
  configSummary,
  isPostgresConfigured,
  loadConfig,
  postgresNotConfiguredDetail,
} from "./config.ts";
import { createDockerEngineClient } from "./docker/engine.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { createPostgresPreviewDb } from "./preview-db/postgres.ts";
import { createRoutingPreviewDb } from "./preview-db/routing.ts";
import { createSqlitePreviewDb } from "./preview-db/sqlite.ts";
import { createPreviewRuntime } from "./preview/runtime.ts";
import { runMigrations } from "./scripts/migrate.ts";
import { startGatewaySweep } from "./sweep/start.ts";

const config = loadConfig();
console.log("sprout starting", configSummary(config));

const { sql, db } = connectState();
await runMigrations(sql);

await bootstrapAdminToken(db, config.adminToken);

const docker = createDockerEngineClient({
  registryPullAuth: config.registryPullAuth,
});

// Only this wiring decides which database adapters exist; per-deploy
// dispatch lives in the PreviewDb / PreviewRuntime seam modules.
const postgresDb = config.postgres
  ? createPostgresPreviewDb({
      url: config.postgres.url,
      previewRole: config.postgres.user,
      previewPassword: config.postgres.password,
    })
  : undefined;
if (postgresDb) await postgresDb.ensurePreviewRole();

const previewDb = createRoutingPreviewDb({
  postgres: postgresDb,
  sqlite: createSqlitePreviewDb(docker),
});

const runtime = createPreviewRuntime({
  pg: config.postgres
    ? {
        host: config.postgres.host,
        port: config.postgres.port,
        user: config.postgres.user,
        password: config.postgres.password,
      }
    : undefined,
  traefikNetwork: config.traefikNetwork,
  postgresNetwork: config.postgres?.network ?? "",
});

const app = bindPreviewOps({
  docker,
  previewPortDefault: config.previewPortDefault,
  traefikTls: config.traefikTls,
  traefikForwardAuth: config.traefikForwardAuth,
  seedTimeoutMs: config.seedTimeout * 1000,
});

const postgresGate = {
  configured: isPostgresConfigured(config),
  detail: (repo: string) => postgresNotConfiguredDetail(config, repo),
};

startServer({ config, db, previewDb, app, runtime, postgresGate });
startGatewaySweep({ config, db, previewDb, app });
console.log(
  `sweep scheduled: first pass in ${config.sweepMinutes}m, then every ${config.sweepMinutes}m`,
);
