import type { PreviewEnvMap } from "@sprout/preview-env";
import { and, eq, ne } from "drizzle-orm";
import type { HealthSpec } from "../app-deployment/health.ts";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import { extractPullDetail } from "../docker/pull-failure.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "../preview-db/names.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";
import {
  canResumeSeed,
  promoteAfterHealthy,
  resumeIncompleteSeed,
} from "./seed-phase.ts";
import type { Result } from "./result.ts";

export type { PreviewRow };

/**
 * Internal SQLite phases (spec): provisioning → starting → seeding → running / failed.
 * Display maps starting/seeding → provisioning for list views.
 */
export type PreviewStatus =
  | "provisioning"
  | "starting"
  | "seeding"
  | "running"
  | "failed"
  | "removing"
  | "removed";

/** Coarse status for list/doctor display (starting/seeding → provisioning). */
export type DisplayPreviewStatus =
  | "provisioning"
  | "running"
  | "failed"
  | "removing"
  | "removed";

export function toDisplayStatus(status: PreviewStatus): DisplayPreviewStatus {
  switch (status) {
    case "starting":
    case "seeding":
      return "provisioning";
    default:
      return status;
  }
}

export type TeardownDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: Pick<PreviewAppOps, "remove">;
};

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
};

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
  appImage: string;
  /** Resolved at the HTTP/CLI boundary — never defaulted here. */
  health: HealthSpec;
  /** Present when deploy requested a seed image; env/args not persisted. */
  seed?: SeedImageSpec;
  /** Adopter KEY=VALUE for the app container; request-scoped, not persisted. */
  appEnv: string[];
  /** Connection env name remap; request-scoped, not persisted. */
  connectionEnv?: PreviewEnvMap;
};

export type TeardownInput = {
  repo: string;
  prId: number;
};

/**
 * Sweep control-plane remove: revalidate generation under lock, then same
 * machine as teardown. Eligibility (TTL / PR-closed) is decided at plan time;
 * under the lock we only verify identity + generation have not moved.
 */
export type RemovePreviewInput = {
  repo: string;
  prId: number;
  expectedDbName: string;
  /** Abort if provision refreshed createdAt since the sweep plan. */
  expectedCreatedAt: string;
};

export type PreviewSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: PreviewStatus;
  preview_url?: string;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};

export function previewSnapshotFromRow(row: PreviewRow): PreviewSnapshot {
  const status = parsePreviewStatus(row.status);
  const parsed = status.ok ? status.value : "failed";
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: parsed,
    ...(parsed === "running" ? { preview_url: `https://${row.hostname}` } : {}),
  };
}

/**
 * Serialize control-plane mutations per (repo, prId).
 * ADR 0001: one gateway process — in-process queue is the concurrency design.
 * ponytail: global Map; upgrade to shared lock if multi-process ever lands.
 */
const previewLocks = new Map<string, Promise<void>>();

/**
 * Serialize catalog DROP/CREATE per dbName so orphan sweep cannot race provision.
 * Taken inside the (repo, prId) lock for lifecycle paths; alone for orphan drops.
 */
const dbNameLocks = new Map<string, Promise<void>>();

function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(previewLocks, `${repo}\0${prId}`, fn);
}

function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(dbNameLocks, dbName, fn);
}

export function parsePreviewStatus(status: string): Result<PreviewStatus> {
  switch (status) {
    case "provisioning":
    case "starting":
    case "seeding":
    case "running":
    case "failed":
    case "removing":
    case "removed":
      return { ok: true, value: status };
    default:
      return { ok: false, status: 500, error: "unknown_preview_status" };
  }
}

export async function getPreviewRow(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<PreviewRow | null> {
  const [existing] = await db
    .select()
    .from(previews)
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    )
    .limit(1);
  return existing ?? null;
}

const clearLastError = {
  lastError: null,
  lastErrorDetail: null,
} as const;

/**
 * Persist a terminal provision failure for GET /v1/preview polling.
 * Seed-resume / seed-run failures keep containerId so the app stays reclaimable.
 * Pull failures against a still-routable container restore `running` so a bad
 * registry blip cannot poison a ready preview (last_error still surfaces on GET).
 */
export async function persistProvisionFailure(
  db: StateDb,
  repo: string,
  prId: number,
  error: string,
  detail?: string,
): Promise<void> {
  const keepContainer =
    error === "seed_image_required_to_resume_seeding" ||
    error === "seed_failed";
  const pullFailed =
    error === "preview_app_deploy_failed" ||
    error === "preview_seed_pull_failed";

  if (pullFailed) {
    const row = await getPreviewRow(db, repo, prId);
    if (row?.containerId) {
      await db
        .update(previews)
        .set({
          status: "running",
          lastError: error,
          lastErrorDetail: detail ?? null,
          updatedAt: utcIsoNow(),
        })
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
      return;
    }
  }

  await db
    .update(previews)
    .set({
      status: "failed",
      ...(keepContainer ? {} : { containerId: null }),
      lastError: error,
      lastErrorDetail: detail ?? null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

/** Replace/health failure: clear containerId so Traefik orphans are not claimed. */
async function markPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
  error: string,
  detail?: string,
): Promise<void> {
  await persistProvisionFailure(db, repo, prId, error, detail);
}

async function writeProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string,
): Promise<PreviewRow> {
  const now = utcIsoNow();
  return updatePreviewRow(
    deps.db,
    { canonicalRepoId: input.repo, prId: input.prId },
    {
      slug: input.slug,
      dbName,
      hostname: input.hostname,
      status: "provisioning",
      appImage: null,
      containerId: null,
      seededAt: null,
      ...clearLastError,
      // New generation: TTL means age of this intent, not birth of the row key.
      createdAt: now,
      updatedAt: now,
    },
    "preview_row_missing_on_intent_write",
  );
}

/** Same-identity accept: flip to provisioning without burning TTL or rewriting routing. */
async function markAcceptProvisioning(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<PreviewRow> {
  const now = utcIsoNow();
  return updatePreviewRow(
    deps.db,
    row,
    {
      status: "provisioning",
      ...clearLastError,
      updatedAt: now,
    },
    "preview_row_missing_on_accept",
  );
}

/** Clear sticky errors without changing phase (seed-resume accept). */
async function clearAcceptErrors(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<PreviewRow> {
  return updatePreviewRow(
    deps.db,
    row,
    {
      ...clearLastError,
      updatedAt: utcIsoNow(),
    },
    "preview_row_missing_on_accept_clear",
  );
}

/** Stuck provisioning accept: remint generation now (complete path does not). */
async function remintAcceptProvisioning(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<PreviewRow> {
  const now = utcIsoNow();
  return updatePreviewRow(
    deps.db,
    row,
    {
      hostname: input.hostname,
      status: "provisioning",
      ...clearLastError,
      createdAt: now,
      updatedAt: now,
    },
    "preview_row_missing_on_accept_remint",
  );
}

/** CREATE under dbName lock only. Callers decide failed vs leave-provisioning. */
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

/**
 * Replace + health only. Ends at healthy `starting` — seed/promote is a
 * separate phase owned by attachThenPromote / promoteAfterHealthy.
 */
async function attachAppContainer(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
  refreshGeneration: boolean,
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
      ...(refreshGeneration ? { createdAt: now } : {}),
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
    // Best-effort remove: failed must not leave a Traefik-routed container
    // claimed by the row (orphan sweep skips keys still in previews).
    try {
      await deps.app.remove(row.slug, row.prId);
    } catch {
      console.warn(
        `preview container remove failed for ${row.slug} pr=${row.prId} after health timeout`,
      );
    }
    await markPreviewFailed(
      deps.db,
      row.canonicalRepoId,
      row.prId,
      "health_timeout",
    );
    return { ok: false, status: 500, error: "health_timeout" };
  }

  return { ok: true, value: starting };
}

/** Project request-scoped seed/remap fields only at the seed-phase boundary. */
function deployEphemerals(input: ProvisionInput) {
  return { seed: input.seed, connectionEnv: input.connectionEnv };
}

/** Attach (replace+health) then promote (running or seed phase). */
async function attachThenPromote(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
  refreshGeneration: boolean,
): Promise<Result<PreviewSnapshot>> {
  const attached = await attachAppContainer(
    deps,
    row,
    input,
    refreshGeneration,
  );
  if (!attached.ok) return attached;
  return promoteAfterHealthy(deps, attached.value, deployEphemerals(input));
}

/**
 * Ensure catalog (DB + companion) under lock; mark failed on ensure error;
 * then attach+promote. Shared by fresh create, recovered identity, and
 * sync/replace paths that inject env.
 */
async function bringUpNew(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
  refreshGeneration: boolean,
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
  return attachThenPromote(deps, row, input, refreshGeneration);
}

/** Post-accept provisioning/starting/running: ensure DB then attach (no seed-resume). */
async function resumeProvisioning(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const ensured = await ensureDatabase(deps, row);
  if (!ensured.ok) return ensured;
  return attachThenPromote(deps, row, input, false);
}

/** slug + dbName ownership; hostname is routing and may change on replace. */
function dbIdentityMatches(
  row: PreviewRow,
  input: ProvisionInput,
  requestedDbName: string,
): boolean {
  return row.slug === input.slug && row.dbName === requestedDbName;
}

function requireDbIdentity(
  row: PreviewRow,
  input: ProvisionInput,
  requestedDbName: string,
): Result<true> {
  if (!dbIdentityMatches(row, input, requestedDbName)) {
    return {
      ok: false,
      status: 409,
      error: "preview_identity_conflict",
    };
  }
  return { ok: true, value: true };
}

/**
 * Accept-time writer of truth: under the preview lock, insert or rewrite a
 * `provisioning` intent row and return its snapshot. Does not pull or bring-up.
 * Seed-resume / identity conflicts that need the request body are left to
 * {@link completeProvisionUnlocked} (durable failure on the row for pollers).
 */
export async function claimDeployIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const requestedDbName = previewDbName(input.slug, input.prId);
  const row = await getPreviewRow(deps.db, input.repo, input.prId);

  if (!row) {
    const [inserted] = await deps.db
      .insert(previews)
      .values({
        canonicalRepoId: input.repo,
        prId: input.prId,
        slug: input.slug,
        dbName: requestedDbName,
        hostname: input.hostname,
        status: "provisioning",
      })
      .returning();
    if (!inserted) {
      return { ok: false, status: 500, error: "preview_row_missing" };
    }
    return { ok: true, value: previewSnapshotFromRow(inserted) };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
    case "removed": {
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      return { ok: true, value: previewSnapshotFromRow(intent) };
    }
    case "failed": {
      if (dbIdentityMatches(row, input, requestedDbName)) {
        // Keep failed+container when seed-incomplete so complete can resume
        // without treating a never-seeded running row as seed-resume.
        if (canResumeSeed(row, input)) {
          const next = await clearAcceptErrors(deps, row);
          return { ok: true, value: previewSnapshotFromRow(next) };
        }
        const next = await markAcceptProvisioning(deps, row);
        return { ok: true, value: previewSnapshotFromRow(next) };
      }
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      return { ok: true, value: previewSnapshotFromRow(intent) };
    }
    case "seeding": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      if (canResumeSeed(row, input)) {
        const next = await clearAcceptErrors(deps, row);
        return { ok: true, value: previewSnapshotFromRow(next) };
      }
      const next = await markAcceptProvisioning(deps, row);
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
    case "running":
    case "starting": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await markAcceptProvisioning(deps, row);
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
    case "provisioning": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await remintAcceptProvisioning(deps, row, input);
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
  }
}

/**
 * Post-accept bring-up under the preview lock. Assumes
 * {@link claimDeployIntent} already wrote/cleared the intent row. Never remints
 * createdAt — accept owns generation.
 */
export async function completeProvisionUnlocked(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const row = await getPreviewRow(deps.db, input.repo, input.prId);
  if (!row) {
    return { ok: false, status: 500, error: "preview_row_missing" };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
    case "removed":
      return { ok: false, status: 404, error: "preview_not_found" };
    case "seeding":
    case "failed": {
      if (canResumeSeed(row, input)) {
        return resumeIncompleteSeed(deps, row, deployEphemerals(input));
      }
      return bringUpNew(deps, row, input, false);
    }
    case "provisioning":
    case "starting":
    case "running":
      return resumeProvisioning(deps, row, input);
  }
}

/** Soft-remove (sweep/teardown) vs hard-delete SQLite row (admin drop). */
type DestroyDisposition = "tombstone" | "purge";

/**
 * Drop the preview DB under the dbName lock, then finalize the control-plane
 * row: soft `removed` (tombstone, reclaimable) or hard DELETE (purge).
 * Must run inside withPreviewLock; never unlock between DROP and finalize.
 */
async function destroyPreviewRow(
  deps: TeardownDeps,
  existing: PreviewRow,
  disposition: DestroyDisposition,
): Promise<Result<TeardownSnapshot>> {
  const repo = existing.canonicalRepoId;
  const prId = existing.prId;

  await deps.db
    .update(previews)
    .set({ status: "removing", updatedAt: utcIsoNow() })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );

  // Best-effort container remove outside dbName lock (still under preview lock).
  // Leftover sprout-* containers are reclaimed by orphan-container sweep.
  try {
    await deps.app.remove(existing.slug, existing.prId);
  } catch {
    console.warn(
      `preview container remove failed for ${existing.slug} pr=${prId}; continuing with DROP`,
    );
  }

  return withDbNameLock(existing.dbName, async () => {
    try {
      await deps.previewDb.dropDatabase(existing.dbName);
    } catch {
      await markPreviewFailed(deps.db, repo, prId, "preview_db_drop_failed");
      return { ok: false, status: 500, error: "preview_db_drop_failed" };
    }

    if (disposition === "purge") {
      await deps.db
        .delete(previews)
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
    } else {
      await deps.db
        .update(previews)
        .set({
          status: "removed",
          containerId: null,
          updatedAt: utcIsoNow(),
        })
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
    }

    return { ok: true, value: { ok: true, status: "removed" } };
  });
}

async function teardownUnlocked(
  deps: TeardownDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  const existing = await getPreviewRow(deps.db, input.repo, input.prId);

  if (!existing) {
    return { ok: true, value: { ok: true, status: "removed" } };
  }

  const status = parsePreviewStatus(existing.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removed":
      return { ok: true, value: { ok: true, status: "removed" } };
    case "provisioning":
    case "starting":
    case "seeding":
    case "running":
    case "failed":
    case "removing":
      break;
  }

  return destroyPreviewRow(deps, existing, "tombstone");
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

/**
 * Pull images then complete bring-up under the preview lock.
 * Call only after {@link claimDeployIntent} has written the provisioning row
 * (async accept path). Pull stays outside the lock so a hung registry cannot
 * stall teardown for the same (repo, prId).
 */
export async function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  if (input.seed) {
    const [appPull, seedPull] = await Promise.all([
      pullImageOrFail(deps.app, input.appImage, "preview_app_deploy_failed"),
      pullImageOrFail(deps.app, input.seed.image, "preview_seed_pull_failed"),
    ]);
    if (!appPull.ok) return appPull;
    if (!seedPull.ok) return seedPull;
  } else {
    const appPull = await pullImageOrFail(
      deps.app,
      input.appImage,
      "preview_app_deploy_failed",
    );
    if (!appPull.ok) return appPull;
  }

  return withPreviewLock(input.repo, input.prId, () =>
    completeProvisionUnlocked(deps, input),
  );
}

export function teardownPreview(
  deps: TeardownDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  return withPreviewLock(input.repo, input.prId, () =>
    teardownUnlocked(deps, input),
  );
}

/**
 * Admin purge: drop the DB and hard-delete the SQLite row under one lock.
 * No soft-remove → unlock → DELETE window (provision cannot reclaim mid-purge).
 * Operator drop is intentionally unversioned — confirm binds to (repo, prId)
 * only; a concurrent redeploy can still be destroyed without a new plan.
 * Container remove is best-effort inside destroyPreviewRow (same as teardown).
 */
export function purgePreview(
  deps: LifecycleDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const existing = await getPreviewRow(deps.db, input.repo, input.prId);
    if (!existing || existing.status === "removed") {
      return { ok: true, value: { ok: true, status: "removed" } };
    }

    const status = parsePreviewStatus(existing.status);
    if (!status.ok) return status;

    return destroyPreviewRow(deps, existing, "purge");
  });
}

/**
 * Sweep control-plane delete: under the same lock as provision/teardown,
 * re-read and abort unless identity + generation still match, then remove.
 * @returns true if the preview was removed; false if the plan was stale.
 */
export function removePreview(
  deps: TeardownDeps,
  input: RemovePreviewInput,
): Promise<Result<boolean>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const existing = await getPreviewRow(deps.db, input.repo, input.prId);
    if (!existing || existing.status === "removed") {
      return { ok: true, value: false };
    }
    if (existing.dbName !== input.expectedDbName) {
      return { ok: true, value: false };
    }
    if (existing.createdAt !== input.expectedCreatedAt) {
      return { ok: true, value: false };
    }

    const status = parsePreviewStatus(existing.status);
    if (!status.ok) return status;

    const result = await destroyPreviewRow(deps, existing, "tombstone");
    if (!result.ok) return result;
    return { ok: true, value: true };
  });
}

/**
 * Orphan catalog DROP under the dbName lock. Aborts if a non-removed
 * preview row claims this name (provision won since plan time).
 * @returns true if DROP ran.
 */
export function dropOrphanDatabase(
  deps: TeardownDeps,
  dbName: string,
): Promise<boolean> {
  return withDbNameLock(dbName, async () => {
    const [claim] = await deps.db
      .select()
      .from(previews)
      .where(and(eq(previews.dbName, dbName), ne(previews.status, "removed")))
      .limit(1);
    if (claim) return false;
    await deps.previewDb.dropDatabase(dbName);
    return true;
  });
}
