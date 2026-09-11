import { bindPreviewOps } from "./app-deployment/ops.ts";
import { bootstrapAdminToken } from "./auth/bootstrap-admin.ts";
import { configSummary, loadConfig } from "./config.ts";
import { createDockerEngineClient } from "./docker/engine.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { createPostgresPreviewDb } from "./preview-db/postgres.ts";
import { runMigrations } from "./scripts/migrate.ts";
import { startGatewaySweep } from "./sweep/start.ts";

const config = loadConfig();
console.log("sprout starting", configSummary(config));

const { sql, db } = connectState();
await runMigrations(sql);

await bootstrapAdminToken(db, config.adminToken);

const previewDb = createPostgresPreviewDb({
  url: config.previewPostgresUrl,
  previewRole: config.previewPgUser,
  previewPassword: config.previewPgPassword,
});
await previewDb.ensurePreviewRole();

const docker = createDockerEngineClient({
  registryPullAuth: config.registryPullAuth,
});

const app = bindPreviewOps({
  docker,
  pg: {
    host: config.previewPgHost,
    port: config.previewPgPort,
    user: config.previewPgUser,
    password: config.previewPgPassword,
  },
  networks: {
    traefik: config.traefikNetwork,
    postgres: config.postgresNetwork,
  },
  previewPortDefault: config.previewPortDefault,
  traefikEntrypoints: config.traefikEntrypoints,
  traefikCertResolver: config.traefikCertResolver,
  seedTimeoutMs: config.seedTimeout * 1000,
});

startServer({ config, db, previewDb, app });
startGatewaySweep({ config, db, previewDb, app });
console.log(
  `sweep scheduled: first pass in ${config.sweepMinutes}m, then every ${config.sweepMinutes}m`,
);