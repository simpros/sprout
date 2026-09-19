import { Elysia } from "elysia";
import { authPlugin, requireAdmin, requireAuth } from "../auth/middleware.ts";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { LifecycleDeps } from "../preview/lifecycle.ts";
import type { MailPresentation } from "../preview/snapshot.ts";
import type { PreviewMaterializationCtx } from "../preview/runtime.ts";
import {
  createDeployToken,
  createDeployTokenBody,
  listTokens,
  revokeToken,
} from "./admin-tokens.ts";
import { deploy, deployBody, getPreview, previewQuery, resetMarkerBody, setResetMarker, teardown, teardownBody } from "./deploy.ts";
import { doctor, drop, dropBody, listPreviews } from "./introspection.ts";
import {
  getPreviewLogs,
  previewLogsParams,
  previewLogsQuery,
} from "./preview-logs.ts";

export type RouteDeps = {
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  materialization: PreviewMaterializationCtx;
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
  const deployDeps = {
    ...lifecycle,
    materialization: deps.materialization,
  };
  const mail: MailPresentation | undefined =
    deps.materialization.mail?.uiUrl !== undefined
      ? { mailboxUrl: deps.materialization.mail.uiUrl }
      : undefined;
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
        .get("/previews", listPreviews(deps.db, mail), {
          beforeHandle: requireAdmin,
        })
        .get("/previews/:id/logs", getPreviewLogs(lifecycle), {
          params: previewLogsParams,
          query: previewLogsQuery,
        })
        .get("/doctor", doctor(lifecycle), {
          beforeHandle: requireAdmin,
        })
        .post("/drop", drop(lifecycle), {
          beforeHandle: requireAdmin,
          body: dropBody,
        })
        .post("/deploy", deploy(deployDeps), { body: deployBody })
        .get("/preview", getPreview(lifecycle, mail), { query: previewQuery })
        .post("/teardown", teardown(lifecycle), { body: teardownBody })
        .post("/reset-marker", setResetMarker(lifecycle), {
          body: resetMarkerBody,
        })
        .all("/*", stubNotImplemented),
    );
}

export type SproutApi = ReturnType<typeof createRoutes>;
