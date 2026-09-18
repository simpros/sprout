import type { PreviewAppOps } from "../app-deployment/ops.ts";
import { extractPullDetail } from "../docker/pull-failure.ts";
import { withDbNameLock } from "./locks.ts";
import { markPreviewFailed, markStickyPreviewFailed } from "./mark-failed.ts";
import {
  canSeedWithoutAppReplace,
  promoteAfterHealthy,
  resumeIncompleteSeed,
} from "./seed-phase.ts";
import type { Result } from "./result.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";
import type {
  BringUpPlan,
  LifecycleDeps,
  PreviewSnapshot,
  ProvisionInput,
} from "./types.ts";

const clearLastError = {
  lastError: null,
  lastErrorDetail: null,
  failureFamily: null,
  seedLog: null,
} as const;

function parseBringUpPlan(raw: string | null): BringUpPlan {
  switch (raw) {
    case "seed_resume":
    case "sync_close":
    case "close":
    case "full_replace":
      return raw;
    default:
      return "full_replace";
  }
}

async function ensureDatabase(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<true>> {
  return withDbNameLock(row.dbName, async () => {
    try {
      await deps.previewDb.createDatabase(row.dbName);
      return { ok: true, value: true };
    } catch {
      return { ok: false, status: 500, error: "preview_db_create_failed" };
    }
  });
}

async function failUnhealthyAttach(
  deps: LifecycleDeps,
  row: Pick<PreviewRow, "slug" | "prId" | "canonicalRepoId">,
  error: string,
): Promise<Result<never>> {
  try {
    await deps.app.remove(row.slug, row.prId);
  } catch {
    console.warn(
      `preview container remove failed for ${row.slug} pr=${row.prId} after ${error}`,
    );
  }
  await markPreviewFailed(
    deps.db,
    row.canonicalRepoId,
    row.prId,
    error,
  );
  return { ok: false, status: 500, error };
}

async function failCompanionSync(
  deps: LifecycleDeps,
  row: Pick<PreviewRow, "canonicalRepoId" | "prId">,
): Promise<Result<never>> {
  await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
    error: "preview_service_deploy_failed",
    family: "post_healthy",
  });
  return {
    ok: false,
    status: 500,
    error: "preview_service_deploy_failed",
  };
}

async function syncPreviewServices(
  deps: LifecycleDeps,
  row: Pick<PreviewRow, "slug" | "prId" | "canonicalRepoId" | "dbName">,
  input: ProvisionInput & { services: NonNullable<ProvisionInput["services"]> },
): Promise<Result<true>> {
  try {
    await deps.app.replaceServices({
      slug: row.slug,
      prId: row.prId,
      appHostname: input.hostname,
      dbName: row.dbName,
      services: input.services,
      connectionEnv: input.connectionEnv,
    });
    return { ok: true, value: true };
  } catch {
    return failCompanionSync(deps, row);
  }
}

async function closeRunning(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<PreviewSnapshot>> {
  const now = utcIsoNow();
  const updated = await updatePreviewRow(
    deps.db,
    row,
    {
      status: "running",
      bringUpPlan: null,
      ...clearLastError,
      updatedAt: now,
    },
    "preview_row_missing_on_running",
  );
  return {
    ok: true,
    value: {
      ok: true,
      canonical_repo_id: updated.canonicalRepoId,
      pr_id: updated.prId,
      slug: updated.slug,
      db_name: updated.dbName,
      hostname: updated.hostname,
      status: "running",
      preview_url: `https://${updated.hostname}`,
    },
  };
}

async function syncThenCloseRunning(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  if (input.services === undefined) {
    await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
      error: "services_required_after_companion_failure",
      family: "post_healthy",
    });
    return {
      ok: false,
      status: 422,
      error: "services_required_after_companion_failure",
    };
  }
  const synced = await syncPreviewServices(deps, row, {
    ...input,
    services: input.services,
  });
  if (!synced.ok) return synced;
  return closeRunning(deps, row);
}

async function finishAfterPromote(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  if (input.services === undefined) {
    return closeRunning(deps, row);
  }
  return syncThenCloseRunning(deps, row, input);
}

function deployEphemerals(input: ProvisionInput) {
  return {
    seed: input.seed,
    connectionEnv: input.connectionEnv,
    fleetPending: input.services !== undefined,
  };
}

async function attachAppContainer(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewRow>> {
  let containerId: string;
  let port: number;
  try {
    ({ containerId, port } = await deps.app.replace({
      slug: row.slug,
      prId: row.prId,
      hostname: input.hostname,
      image: input.appImage,
      dbName: row.dbName,
      appEnv: input.appEnv,
      connectionEnv: input.connectionEnv,
    }));
  } catch {
    await markPreviewFailed(
      deps.db,
      row.canonicalRepoId,
      row.prId,
      "preview_app_deploy_failed",
    );
    return { ok: false, status: 500, error: "preview_app_deploy_failed" };
  }

  const now = utcIsoNow();
  const starting = await updatePreviewRow(
    deps.db,
    row,
    {
      hostname: input.hostname,
      appImage: input.appImage,
      containerId,
      status: "starting",
      ...clearLastError,
      updatedAt: now,
    },
    "preview_row_missing_on_app_attach",
  );

  const outcome = await deps.app.waitHealthy(
    containerId,
    port,
    input.health,
  );
  if (outcome === "timeout") {
    console.warn("health:timeout");
    return failUnhealthyAttach(deps, row, "health_timeout");
  }

  return { ok: true, value: starting };
}

async function attachThenPromote(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const attached = await attachAppContainer(deps, row, input);
  if (!attached.ok) return attached;
  let starting = attached.value;
  // Clear after healthy attach so pull/health failure cannot erase a prior
  // successful seed marker; promote's seed gate is `seededAt == null`.
  if (input.reseed === true && starting.seededAt != null) {
    starting = await updatePreviewRow(
      deps.db,
      starting,
      { seededAt: null, updatedAt: utcIsoNow() },
      "preview_row_missing_on_reseed_clear",
    );
  }
  const promoted = await promoteAfterHealthy(
    deps,
    starting,
    deployEphemerals(input),
  );
  if (!promoted.ok) return promoted;
  return finishAfterPromote(deps, starting, input);
}

async function ensureThenAttach(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const ensured = await ensureDatabase(deps, row);
  if (!ensured.ok) {
    await markPreviewFailed(
      deps.db,
      row.canonicalRepoId,
      row.prId,
      ensured.error,
    );
    return ensured;
  }
  return attachThenPromote(deps, row, input);
}

async function pullImageOrFail(
  app: PreviewAppOps,
  image: string,
  error: string,
): Promise<Result<true>> {
  try {
    await app.pullImage(image);
    return { ok: true, value: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error,
      detail: extractPullDetail(err),
    };
  }
}

export async function pullImagesOutsideLock(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<true>> {
  const pulls: Promise<Result<true>>[] = [
    pullImageOrFail(deps.app, input.appImage, "preview_app_pull_failed"),
  ];
  if (input.seed) {
    pulls.push(
      pullImageOrFail(deps.app, input.seed.image, "preview_seed_pull_failed"),
    );
  }
  for (const service of input.services ?? []) {
    pulls.push(
      pullImageOrFail(
        deps.app,
        service.image,
        "preview_service_pull_failed",
      ),
    );
  }
  const results = await Promise.all(pulls);
  for (const result of results) {
    if (!result.ok) return result;
  }
  return { ok: true, value: true };
}

export async function completeBringUp(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  switch (parseBringUpPlan(row.bringUpPlan)) {
    case "seed_resume": {
      // Accept already gated sameApp before writing this plan. Silent
      // escalate to replace would hide accept bugs behind Traefik flaps.
      if (!canSeedWithoutAppReplace(row, input)) {
        return {
          ok: false,
          status: 500,
          error: "preview_plan_conflict",
        };
      }
      const seeded = await resumeIncompleteSeed(
        deps,
        row,
        deployEphemerals(input),
      );
      if (!seeded.ok) return seeded;
      return finishAfterPromote(deps, row, input);
    }
    case "sync_close":
      return syncThenCloseRunning(deps, row, input);
    case "close":
      return closeRunning(deps, row);
    case "full_replace":
      return ensureThenAttach(deps, row, input);
  }
}
