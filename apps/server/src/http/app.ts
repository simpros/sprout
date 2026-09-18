import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewRuntime } from "../preview/runtime.ts";
import type { PostgresGate } from "./deploy.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  runtime: PreviewRuntime;
  postgresGate: PostgresGate;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    runtime: deps.runtime,
    postgresGate: deps.postgresGate,
  }).listen(deps.config.port);
}
