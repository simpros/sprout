import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import type { PostgresGate } from "./deploy.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
  postgresGate?: PostgresGate;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    ...(deps.postgresGate === undefined
      ? {}
      : { postgresGate: deps.postgresGate }),
  }).listen(deps.config.port);
}
