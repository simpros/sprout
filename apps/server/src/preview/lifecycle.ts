import { and, eq, ne } from "drizzle-orm";
import type { PreviewAppOps } from "../app-deployment/replace.ts";
import {
  defaultHealthProbe,
  healthUrl,
  pollHealth,
  type HealthClock,
  type HealthProbe,
  type HealthSpec,
  DEFAULT_HEALTH,
} from "../app-deployment/health.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "../preview-db/names.ts";
import type { PreviewDb } from "../preview-db/port.ts";

function utcIsoNow(): string {
  return new Date().toISOString();
}

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
  /** Docker network name used for health polls (PB_POSTGRES_NETWORK). */
  postgresNetwork: string;
  healthProbe?: HealthProbe;
  healthClock?: HealthClock;
  log?: (message: string) => void;
};

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
  appImage: string;
  health?: HealthSpec;
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

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export type PreviewRow = typeof previews.$inferSelect;

/**
 * Serialize control-plane mutations per (repo, prId).
 * ADR 0001: one gateway process — in-process queue is the concurrency design.
 * ponytail: global Map; upgrade to shared lock if multi-process ever lands.
 */
const previewLocks = new Map<string, Promise<void>>();

function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${repo}\0${prId}`;
  const prev = previewLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  previewLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Serialize catalog DROP/CREATE per dbName so orphan sweep cannot race provision.
 * Taken inside the (repo, prId) lock for lifecycle paths; alone for orphan drops.
 */
const dbNameLocks = new Map<string, Promise<void>>();

function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = dbNameLocks.get(dbName) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  dbNameLocks.set(
    dbName,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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

async function getPreviewRow(
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

function toSnapshot(
  row: PreviewRow,
  status: PreviewStatus,
): PreviewSnapshot {
  const snap: PreviewSnapshot = {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status,
  };
  if (status === "running") {
    snap.preview_url = `https://${row.hostname}`;
  }
  return snap;
}

async function markPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<void> {
  await db
    .update(previews)
    .set({ status: "failed", updatedAt: utcIsoNow() })
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
  const [updated] = await deps.db
    .update(previews)
    .set({
      slug: input.slug,
      dbName,
      hostname: input.hostname,
      status: "provisioning",
      appImage: null,
      containerId: null,
      seededAt: null,
      // New generation: TTL means age of this intent, not birth of the row key.
      createdAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error("preview_row_missing_on_intent_write");
  }
  return updated;
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

type AttachInput = {
  hostname: string;
  appImage: string;
  health: HealthSpec;
};

async function attachAppContainer(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: AttachInput,
  refreshGeneration: boolean,
): Promise<Result<PreviewSnapshot>> {
  let containerId: string;
  let port: number;
  try {
    ({ containerId, port } = await deps.app.replace({
      slug: row.slug,
      prId: row.prId,
      hostname: input.hostname,
      image: input.appImage,
      dbName: row.dbName,
    }));
  } catch {
    await markPreviewFailed(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "preview_app_deploy_failed" };
  }

  const now = utcIsoNow();
  const [starting] = await deps.db
    .update(previews)
    .set({
      hostname: input.hostname,
      appImage: input.appImage,
      containerId,
      status: "starting",
      ...(refreshGeneration ? { createdAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(previews.canonicalRepoId, row.canonicalRepoId),
        eq(previews.prId, row.prId),
      ),
    )
    .returning();
  if (!starting) {
    throw new Error("preview_row_missing_on_app_attach");
  }

  const ip = await deps.app.containerIpOnNetwork(
    containerId,
    deps.postgresNetwork,
  );
  if (!ip) {
    deps.log?.("health:timeout (no container IP on postgres network)");
    await markPreviewFailed(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "health_timeout" };
  }

  const probe = deps.healthProbe ?? defaultHealthProbe();
  const outcome = await pollHealth(
    probe,
    healthUrl(ip, port, input.health.path),
    input.health,
    deps.healthClock,
  );
  if (outcome === "timeout") {
    deps.log?.(`health:timeout ${healthUrl(ip, port, input.health.path)}`);
    await markPreviewFailed(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "health_timeout" };
  }

  const [updated] = await deps.db
    .update(previews)
    .set({ status: "running", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, row.canonicalRepoId),
        eq(previews.prId, row.prId),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error("preview_row_missing_on_running");
  }
  return { ok: true, value: toSnapshot(updated, "running") };
}

/** Fresh / recovered identity: CREATE failure → failed; else attach. */
async function bringUpNew(
  deps: LifecycleDeps,
  row: PreviewRow,
  attachInput: AttachInput,
  refreshGeneration: boolean,
): Promise<Result<PreviewSnapshot>> {
  const ensured = await ensureDatabase(deps, row);
  if (!ensured.ok) {
    await markPreviewFailed(deps.db, row.canonicalRepoId, row.prId);
    return ensured;
  }
  return attachAppContainer(deps, row, attachInput, refreshGeneration);
}

/** Stuck-create resume: leave provisioning on CREATE failure; else attach. */
async function resumeProvisioning(
  deps: LifecycleDeps,
  row: PreviewRow,
  attachInput: AttachInput,
): Promise<Result<PreviewSnapshot>> {
  const ensured = await ensureDatabase(deps, row);
  if (!ensured.ok) return ensured;
  // Mint generation when stuck-create finally becomes live.
  return attachAppContainer(deps, row, attachInput, true);
}

/** slug + dbName ownership; hostname is routing and may change on replace. */
function dbIdentityMatches(
  row: PreviewRow,
  input: ProvisionInput,
  requestedDbName: string,
): boolean {
  return row.slug === input.slug && row.dbName === requestedDbName;
}

async function provisionUnlocked(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const requestedDbName = previewDbName(input.slug, input.prId);
  const attachInput: AttachInput = {
    hostname: input.hostname,
    appImage: input.appImage,
    health: input.health ?? DEFAULT_HEALTH,
  };
  let row = await getPreviewRow(deps.db, input.repo, input.prId);

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
    // First live: mint generation at attach (DB+app ready).
    return bringUpNew(deps, inserted, attachInput, true);
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removed": {
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      // Intent write already minted createdAt — do not remint on attach.
      return bringUpNew(deps, intent, attachInput, false);
    }
    case "failed": {
      // Same slug/dbName: resume without burning TTL generation.
      if (dbIdentityMatches(row, input, requestedDbName)) {
        return bringUpNew(deps, row, attachInput, false);
      }
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      return bringUpNew(deps, intent, attachInput, false);
    }
    case "provisioning":
    case "starting":
    case "seeding":
    case "running": {
      // Live claim: refuse slug/dbName rewrite mid-flight / on replace.
      // Hostname/image may still change when identity matches.
      if (!dbIdentityMatches(row, input, requestedDbName)) {
        return {
          ok: false,
          status: 409,
          error: "preview_identity_conflict",
        };
      }
      if (status.value === "running") {
        return attachAppContainer(deps, row, attachInput, false);
      }
      // provisioning / starting / seeding: ensure DB then attach + health.
      return resumeProvisioning(deps, row, attachInput);
    }
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
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
  // Leftover pb-* containers are reclaimed by orphan-container sweep.
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
      await markPreviewFailed(deps.db, repo, prId);
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

/**
 * Ensure a preview DB + healthy app container exist for (repo, prId).
 * - removed: rewrite identity, CREATE, start/replace app, health → running
 * - failed + same slug/dbName: ensure DB + attach without burning generation
 * - failed + new slug/dbName: rewrite intent, then bring-up
 * - provisioning|starting|seeding + same slug/dbName: retry CREATE, then health
 * - running + same slug/dbName: replace app (hostname/image may change) + health
 * - live + slug/dbName mismatch: 409 preview_identity_conflict
 * - removing: 409
 *
 * Registry pull runs outside the preview lock so a hung pull cannot stall
 * teardown for the same (repo, prId). Port inspect stays inside replace.
 * Health poll holds the preview lock (same-PR teardown queues behind).
 */
export async function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  try {
    await deps.app.pullImage(input.appImage);
  } catch {
    // Preflight only — do not poison a live running/provisioning row.
    // Attach under the lock marks failed when replace actually fails.
    return { ok: false, status: 500, error: "preview_app_deploy_failed" };
  }

  return withPreviewLock(input.repo, input.prId, () =>
    provisionUnlocked(deps, input),
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
