import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewMaterializationCtx } from "../preview/runtime.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  materialization: PreviewMaterializationCtx;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    materialization: deps.materialization,
  }).listen(deps.config.port);
}
