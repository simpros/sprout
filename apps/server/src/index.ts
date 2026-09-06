import { bindPreviewApp } from "./app-deployment/replace.ts";
import { ensureAdminToken } from "./auth/store.ts";
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

const generatedAdminToken = await ensureAdminToken(db, config.adminToken);
if (generatedAdminToken) {
  console.warn(
    "SPROUT_ADMIN_TOKEN not set; generated bootstrap admin token (store securely):",
    generatedAdminToken,
  );
}

const previewDb = createPostgresPreviewDb({
  url: config.previewPostgresUrl,
  previewRole: config.previewPgUser,
});

const docker = createDockerEngineClient({
  registryAuth:
    config.registryUser === ""
      ? undefined
      : {
          username: config.registryUser,
          password: config.registryPassword,
        },
});

const app = bindPreviewApp({
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
});

startServer({ config, db, previewDb, app });
startGatewaySweep({ config, db, previewDb, app });
console.log(
  `sweep scheduled: first pass in ${config.sweepMinutes}m, then every ${config.sweepMinutes}m`,
);