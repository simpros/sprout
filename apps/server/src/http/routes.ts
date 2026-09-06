import { Elysia } from "elysia";
import { authPlugin, requireAdmin, requireAuth } from "../auth/middleware.ts";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import type { LifecycleDeps } from "../preview/lifecycle.ts";
import {
  createDeployToken,
  createDeployTokenBody,
  listTokens,
  revokeToken,
} from "./admin-tokens.ts";
import { deploy, deployBody, teardown, teardownBody } from "./deploy.ts";
import { doctor, drop, dropBody, listPreviews } from "./introspection.ts";

export type RouteDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
};

function stubNotImplemented({
  set,
}: {
  set: { status?: number | string };
}) {
  set.status = 501;
  return { error: "not implemented" };
}

export function createRoutes(deps: RouteDeps) {
  const lifecycle: LifecycleDeps = {
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
  };
  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (v1) =>
      v1
        .use(authPlugin(deps.db))
        .onBeforeHandle(requireAuth)
        .group("/admin", (admin) =>
          admin
            .onBeforeHandle(requireAdmin)
            .get("/tokens", listTokens(deps.db))
            .post("/tokens", createDeployToken(deps.db), {
              body: createDeployTokenBody,
            })
            .delete("/tokens/:id", revokeToken(deps.db)),
        )
        .get("/previews", listPreviews(deps.db), {
          beforeHandle: requireAdmin,
        })
        .get("/doctor", doctor(lifecycle), {
          beforeHandle: requireAdmin,
        })
        .post("/drop", drop(lifecycle), {
          beforeHandle: requireAdmin,
          body: dropBody,
        })
        .post("/deploy", deploy(lifecycle), { body: deployBody })
        .post("/teardown", teardown(lifecycle), { body: teardownBody })
        .all("/*", stubNotImplemented),
    );
}

export type PreviewBuddyApi = ReturnType<typeof createRoutes>;
