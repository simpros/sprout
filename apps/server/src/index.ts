import { bindPreviewOps } from "./app-deployment/ops.ts";
import { bootstrapAdminToken } from "./auth/bootstrap-admin.ts";
import {
  configSummary,
  loadConfig,
} from "./config.ts";
import { createDockerEngineClient } from "./docker/engine.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { createPostgresPreviewDb } from "./preview-db/postgres.ts";
import { createRoutingPreviewDb } from "./preview-db/routing.ts";
import { createSqlitePreviewDb } from "./preview-db/sqlite.ts";
import type { PreviewMaterializationCtx } from "./preview/runtime.ts";
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
// dispatch lives in the PreviewDb / plan-resolution seam modules.
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

// The single materialization input every deploy resolves its plan from.
// Postgres presence lives only here; the deploy gate reads ctx.postgres.
// Mail presence lives only here too; it never provisions, only injects.
const pg = config.postgres;
const mail = config.mail;
const materialization: PreviewMaterializationCtx = {
  traefikNetwork: config.traefikNetwork,
  ...(pg
    ? {
        postgres: {
          pg: {
            host: pg.host,
            port: pg.port,
            user: pg.user,
            password: pg.password,
          },
          network: pg.network,
        },
      }
    : {}),
  ...(mail
    ? {
        mail: {
          mail: {
            host: mail.host,
            port: mail.port,
            user: mail.user,
            password: mail.password,
            ...(mail.secure ? { secure: true as const } : {}),
            fromDomain: mail.fromDomain,
          },
          ...(mail.network !== undefined ? { network: mail.network } : {}),
          ...(mail.uiUrl !== undefined ? { uiUrl: mail.uiUrl } : {}),
        },
      }
    : {}),
};

const app = bindPreviewOps({
  docker,
  previewPortDefault: config.previewPortDefault,
  traefikTls: config.traefikTls,
  traefikForwardAuth: config.traefikForwardAuth,
  seedTimeoutMs: config.seedTimeout * 1000,
});

startServer({ config, db, previewDb, app, materialization });
startGatewaySweep({ config, db, previewDb, app });
console.log(
  `sweep scheduled: first pass in ${config.sweepMinutes}m, then every ${config.sweepMinutes}m`,
);
