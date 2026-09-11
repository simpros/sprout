import { and, eq, ne } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "../preview-db/names.ts";
import { completeBringUp, pullImagesOutsideLock } from "./bring-up.ts";
import { withDbNameLock, withPreviewLock } from "./locks.ts";
import { markPreviewFailed } from "./mark-failed.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";
import { canSeedWithoutAppReplace } from "./seed-phase.ts";
import type { Result } from "./result.ts";
import type {
  DisplayPreviewStatus,
  LifecycleDeps,
  PreviewSnapshot,
  PreviewStatus,
  ProvisionInput,
  RemovePreviewInput,
  TeardownDeps,
  TeardownInput,
  TeardownSnapshot,
} from "./types.ts";

export type { PreviewRow };
export type {
  DisplayPreviewStatus,
  LifecycleDeps,
  PreviewSnapshot,
  PreviewStatus,
  ProvisionInput,
  RemovePreviewInput,
  TeardownDeps,
  TeardownInput,
  TeardownSnapshot,
} from "./types.ts";
export { withPreviewLock, withDbNameLock } from "./locks.ts";
export {
  markPreviewFailed,
  markStickyPreviewFailed,
} from "./mark-failed.ts";

export function toDisplayStatus(status: PreviewStatus): DisplayPreviewStatus {
  switch (status) {
    case "starting":
    case "seeding":
      return "provisioning";
    default:
      return status;
  }
}

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
  failureFamily: null,
  seedLog: null,
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
        failureFamily: null,
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
      failureFamily: null,
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
 * Preserves failureFamily so bring-up can select post_healthy sync-only vs
 * full replace; cleared on successful closeRunning / attach.
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
      lastError: null,
      lastErrorDetail: null,
      seedLog: null,
      ...(fields.remint ? { createdAt: now } : {}),
      updatedAt: now,
    },
    "preview_row_missing_on_accept",
  );
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
 * - seeding + same app → seeding (resume incomplete seed)
 * - failed + same app + failureFamily seed_incomplete → seeding
 * - failed + post_healthy (or other) sticky fail → provisioning
 *   (bring-up: post_healthy + sameApp → sync-only; else replace→sync)
 * - running/starting + reseed + same app → seeding (seed-only reseed)
 * - else → provisioning (replace path)
 * seeded_at clears after healthy attach or on seed-phase entry.
 * failureFamily survives patchAccept for bring-up to consume.
 */
function planAcceptBringUp(
  row: PreviewRow,
  input: ProvisionInput,
  status: "failed" | "seeding" | "running" | "starting",
): "seeding" | "provisioning" {
  const sameApp = canSeedWithoutAppReplace(row, input);
  if (status === "seeding") {
    return sameApp ? "seeding" : "provisioning";
  }
  if (status === "failed") {
    if (sameApp && row.failureFamily === "seed_incomplete") {
      return "seeding";
    }
    return "provisioning";
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
 * terminal after accept). `post_healthy` failureFamily survives claim so
 * bring-up can sync companions without replacing the healthy app.
 *
 * Bring-up pipeline (see bring-up.ts): attach → promote/seed → sync → running
 * (or seed-resume → sync → running; or post_healthy sync-only → running).
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
  return completeBringUp(deps, row, input, status.value);
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
