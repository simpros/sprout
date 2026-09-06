import type { PreviewAppOps } from "../app-deployment/replace.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
  }).listen(deps.config.port);
}
