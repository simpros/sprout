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
  canSeedWithoutAppReplace,
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
  /**
   * Lifecycle-only: seed-only accept plan when same-app, and clear seeded_at
   * after healthy attach (replace path). Seed-only path clears inside
   * runSeedPhase. Never forwarded into DeployEphemerals.
   */
  reseed?: boolean;
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
  /** Sticky last deploy attempt; independent of phase (e.g. running + pull fail). */
  last_error?: string;
  last_error_detail?: string;
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
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
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
 * Registry pull failed before replace. Must run under {@link withPreviewLock}.
 * No-ops if teardown already won (`removing` / `removed` / missing). If a
 * container is still claimed, restore `running` so a bad registry blip cannot
 * poison a ready preview. Sticky `last_error` fields travel on the snapshot.
 * Used only from the pull preflight path — never for bring-up / replace.
 */
async function persistPullFailure(
  db: StateDb,
  repo: string,
  prId: number,
  error: string,
  detail?: string,
): Promise<void> {
  const row = await getPreviewRow(db, repo, prId);
  if (!row || row.status === "removing" || row.status === "removed") {
    return;
  }
  if (row.containerId) {
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

  await db
    .update(previews)
    .set({
      status: "failed",
      containerId: null,
      lastError: error,
      lastErrorDetail: detail ?? null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

/**
 * Bring-up / replace / health / ensure / drop failure: clear containerId so
 * Traefik orphans are not claimed. Callers that run outside a held preview
 * lock (background catch) must wrap with {@link withPreviewLock} and skip
 * `removing` / `removed` so teardown cannot be resurrected.
 */
export async function markPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
  error: string,
  detail?: string,
): Promise<void> {
  await db
    .update(previews)
    .set({
      status: "failed",
      containerId: null,
      lastError: error,
      lastErrorDetail: detail ?? null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
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

/**
 * Same-identity accept patch: clear sticky errors and set the in-flight plan
 * status. Optional remint advances TTL generation (stuck provisioning only).
 * Does not touch seeded_at — that clears after healthy attach or on seed entry.
 */
async function patchAccept(
  deps: LifecycleDeps,
  row: PreviewRow,
  fields: {
    status: "provisioning" | "seeding";
    remint?: boolean;
    hostname?: string;
  },
): Promise<PreviewRow> {
  const now = utcIsoNow();
  return updatePreviewRow(
    deps.db,
    row,
    {
      status: fields.status,
      ...(fields.hostname != null ? { hostname: fields.hostname } : {}),
      ...clearLastError,
      ...(fields.remint ? { createdAt: now } : {}),
      updatedAt: now,
    },
    "preview_row_missing_on_accept",
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
 * Accept owns generation remint; attach never touches createdAt.
 */
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
  return {
    seed: input.seed,
    connectionEnv: input.connectionEnv,
  };
}

/** Attach (replace+health) then promote (running or seed phase). */
async function attachThenPromote(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const attached = await attachAppContainer(deps, row, input);
  if (!attached.ok) return attached;
  let starting = attached.value;
  // Clear after healthy attach so pull/health failure cannot erase a prior
  // successful seed marker. Promote stays dumb on seeded_at.
  if (input.reseed === true && starting.seededAt != null) {
    starting = await updatePreviewRow(
      deps.db,
      starting,
      { seededAt: null, updatedAt: utcIsoNow() },
      "preview_row_missing_on_reseed_clear",
    );
  }
  return promoteAfterHealthy(deps, starting, deployEphemerals(input));
}

/**
 * Ensure catalog DB under lock; mark failed on ensure error; then attach+promote.
 * Single post-accept bring-up path (accept already reminted / wrote intent).
 */
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
 * Shared accept plan for identity-matched rows that may seed without replace.
 * - failed/seeding + same app → seeding (resume incomplete seed)
 * - running/starting + reseed + same app → seeding (seed-only reseed)
 * - else → provisioning (replace path)
 * Status only — seeded_at clears after healthy attach or on seed-phase entry.
 */
function planAcceptBringUp(
  row: PreviewRow,
  input: ProvisionInput,
  status: "failed" | "seeding" | "running" | "starting",
): "seeding" | "provisioning" {
  const sameApp = canSeedWithoutAppReplace(row, input);
  if (status === "failed" || status === "seeding") {
    return sameApp ? "seeding" : "provisioning";
  }
  return input.reseed === true && sameApp ? "seeding" : "provisioning";
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
        // Seed-resume accept writes in-flight `seeding` so `failed` stays
        // terminal-only for CLI pollers (keep containerId/appImage).
        const next = await patchAccept(deps, row, {
          status: planAcceptBringUp(row, input, "failed"),
        });
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
      const next = await patchAccept(deps, row, {
        status: planAcceptBringUp(row, input, "seeding"),
      });
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
    case "running":
    case "starting": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await patchAccept(deps, row, {
        status: planAcceptBringUp(row, input, status.value),
      });
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
    case "provisioning": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await patchAccept(deps, row, {
        status: "provisioning",
        remint: true,
        hostname: input.hostname,
      });
      return { ok: true, value: previewSnapshotFromRow(next) };
    }
  }
}

/**
 * Post-accept bring-up under the preview lock. Assumes
 * {@link claimDeployIntent} already wrote/cleared the intent row. Never remints
 * createdAt — accept owns generation.
 *
 * Status after claim is the plan: seed-resume / seed-only reseed is `seeding`;
 * everything else is `provisioning`. Do not re-enter seed on a live same-image
 * row — that still has containerId/appImage and would wrongly match
 * canSeedWithoutAppReplace without the seeding-only guard (`failed` is
 * terminal after accept).
 */
async function completeProvisionUnlocked(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const row = await getPreviewRow(deps.db, input.repo, input.prId);
  if (!row) {
    return { ok: false, status: 500, error: "preview_row_missing" };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  if (status.value === "removing") {
    return {
      ok: false,
      status: 409,
      error: "preview_teardown_in_progress",
    };
  }
  if (status.value === "removed") {
    return { ok: false, status: 404, error: "preview_not_found" };
  }
  if (status.value === "seeding" && canSeedWithoutAppReplace(row, input)) {
    return resumeIncompleteSeed(deps, row, deployEphemerals(input));
  }
  return ensureThenAttach(deps, row, input);
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

/** Pull app (+ optional seed) outside the preview lock. */
async function pullImagesOutsideLock(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<true>> {
  if (input.seed) {
    const [appPull, seedPull] = await Promise.all([
      pullImageOrFail(deps.app, input.appImage, "preview_app_pull_failed"),
      pullImageOrFail(deps.app, input.seed.image, "preview_seed_pull_failed"),
    ]);
    if (!appPull.ok) return appPull;
    if (!seedPull.ok) return seedPull;
    return { ok: true, value: true };
  }
  return pullImageOrFail(
    deps.app,
    input.appImage,
    "preview_app_pull_failed",
  );
}

/**
 * Pull images then complete bring-up under the preview lock.
 * Call only after {@link claimDeployIntent} has written the provisioning row
 * (async accept path). Pull stays outside the lock so a hung registry cannot
 * stall teardown; durable pull-failure writes happen under the lock so they
 * cannot resurrect a `removed` row.
 */
export async function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const pull = await pullImagesOutsideLock(deps, input);
  return withPreviewLock(input.repo, input.prId, async () => {
    if (!pull.ok) {
      await persistPullFailure(
        deps.db,
        input.repo,
        input.prId,
        pull.error,
        pull.detail,
      );
      return pull;
    }
    return completeProvisionUnlocked(deps, input);
  });
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
