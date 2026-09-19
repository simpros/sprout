import { and, eq, ne } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { completeBringUp, pullImagesOutsideLock } from "./bring-up.ts";
import { withDbNameLock, withPreviewLock } from "./locks.ts";
import { markPreviewFailed } from "./mark-failed.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  needsBackendRemint,
  storedProvider,
  type PreviewRow,
} from "./row.ts";
import { canSeedWithoutAppReplace, seedWorkOutstanding } from "./seed-phase.ts";
import type { Result } from "./result.ts";
import {
  parsePreviewStatus,
  planMailFrom,
  previewSnapshotFromRow,
  type MailPresentation,
} from "./snapshot.ts";
import type {
  BringUpPlan,
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
  BringUpPlan,
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

/** Persist the handled MR/PR-body reset marker; row must exist (incl. removed). */
export async function setResetRequestMarker(
  db: StateDb,
  repo: string,
  prId: number,
  marker: string,
): Promise<Result<PreviewRow>> {
  return withPreviewLock(repo, prId, async () => {
    const row = await getPreviewRow(db, repo, prId);
    if (!row) {
      return { ok: false as const, status: 404, error: "preview_not_found" };
    }
    const next = await updatePreviewRow(
      db,
      { canonicalRepoId: repo, prId },
      { resetRequestMarker: marker, updatedAt: utcIsoNow() },
      "preview_row_missing_on_reset_marker",
    );
    return { ok: true as const, value: next };
  });
}

type AcceptBringUp = {
  status: "provisioning" | "seeding";
  plan: BringUpPlan;
};

/** Must run under withPreviewLock; skips removing/removed rows. */
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
        bringUpPlan: null,
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
      bringUpPlan: null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

async function writeProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string | null,
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
      bringUpPlan: "full_replace",
      appImage: null,
      containerId: null,
      seededAt: null,
      seededSeedImage: null,
      mailFrom: planMailFrom(input.plan),
      ...clearLastError,
      // New generation: TTL means age of this intent, not birth of the row key.
      createdAt: now,
      updatedAt: now,
    },
    "preview_row_missing_on_intent_write",
  );
}

async function patchAccept(
  deps: LifecycleDeps,
  row: PreviewRow,
  fields: {
    status: "provisioning" | "seeding";
    plan: BringUpPlan;
    remint?: boolean;
    hostname?: string;
  },
  dbPlan: ProvisionInput["plan"],
): Promise<PreviewRow> {
  const now = utcIsoNow();
  return updatePreviewRow(
    deps.db,
    row,
    {
      status: fields.status,
      bringUpPlan: fields.plan,
      ...(fields.hostname != null ? { hostname: fields.hostname } : {}),
      mailFrom: planMailFrom(dbPlan),
      lastError: null,
      lastErrorDetail: null,
      seedLog: null,
      ...(fields.remint ? { createdAt: now } : {}),
      updatedAt: now,
    },
    "preview_row_missing_on_accept",
  );
}

function dbIdentityMatches(
  row: PreviewRow,
  input: ProvisionInput,
  requestedDbName: string | null,
): boolean {
  return row.slug === input.slug && row.dbName === requestedDbName;
}

function requireDbIdentity(
  row: PreviewRow,
  input: ProvisionInput,
  requestedDbName: string | null,
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

function planAcceptBringUp(
  row: PreviewRow,
  input: ProvisionInput,
  status: "failed" | "seeding" | "running" | "starting",
): AcceptBringUp {
  const sameApp = canSeedWithoutAppReplace(row, input);

  if (sameApp) {
    if (row.bringUpPlan === "sync_close") {
      return { status: "provisioning", plan: "sync_close" };
    }
    if (row.bringUpPlan === "close") {
      return { status: "provisioning", plan: "close" };
    }
    if (
      row.bringUpPlan === "seed_resume" &&
      (status === "failed" || status === "seeding")
    ) {
      return { status: "seeding", plan: "seed_resume" };
    }
    // Back-compat: rows seeded before close plans existed resume as close.
    if (status === "seeding" && row.seededAt != null) {
      return { status: "provisioning", plan: "close" };
    }
  }

  if (status === "seeding") {
    return sameApp
      ? { status: "seeding", plan: "seed_resume" }
      : { status: "provisioning", plan: "full_replace" };
  }
  if (status === "failed") {
    return { status: "provisioning", plan: "full_replace" };
  }
  if (sameApp && seedWorkOutstanding(row, input.seed, input.reseed)) {
    return { status: "seeding", plan: "seed_resume" };
  }
  return { status: "provisioning", plan: "full_replace" };
}
/** Config-level mailbox link for a snapshot; From is read from the row. */
function mailboxOf(plan: ProvisionInput["plan"]): MailPresentation | undefined {
  return plan.mailboxUrl !== undefined
    ? { mailboxUrl: plan.mailboxUrl }
    : undefined;
}
export async function claimDeployIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const requestedDbName = input.plan.dbName;
  const row = await getPreviewRow(deps.db, input.repo, input.prId);

  if (!row) {
    const [inserted] = await deps.db
      .insert(previews)
      .values({
        canonicalRepoId: input.repo,
        prId: input.prId,
        slug: input.slug,
        dbName: requestedDbName,
        dbProvider: input.plan.provider,
        hostname: input.hostname,
        status: "provisioning",
        bringUpPlan: "full_replace",
        mailFrom: planMailFrom(input.plan),
      })
      .returning();
    if (!inserted) {
      return { ok: false, status: 500, error: "preview_row_missing" };
    }
    return {
      ok: true,
      value: previewSnapshotFromRow(inserted, mailboxOf(input.plan)),
    };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  // A provider switch is a fresh generation: seed_resume and companion sync
  // assume the stored backend, so fall through to a full_replace intent that
  // bring-up reconciles (old backend dropped, new one created). A null
  // desired name keeps the stale name through the intent so bring-up can
  // drop it before nulling the column.
  if (
    status.value !== "removing" &&
    needsBackendRemint(row, input.plan.provider)
  ) {
    const intentDbName = requestedDbName ?? row.dbName;
    const intent = await writeProvisioningIntent(deps, input, intentDbName);
    return {
      ok: true,
      value: previewSnapshotFromRow(intent, mailboxOf(input.plan)),
    };
  }

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
      return {
        ok: true,
        value: previewSnapshotFromRow(intent, mailboxOf(input.plan)),
      };
    }
    case "failed": {
      if (dbIdentityMatches(row, input, requestedDbName)) {
        const planned = planAcceptBringUp(row, input, "failed");
        const next = await patchAccept(deps, row, planned, input.plan);
        return {
          ok: true,
          value: previewSnapshotFromRow(next, mailboxOf(input.plan)),
        };
      }
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      return {
        ok: true,
        value: previewSnapshotFromRow(intent, mailboxOf(input.plan)),
      };
    }
    case "seeding": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await patchAccept(
        deps,
        row,
        planAcceptBringUp(row, input, "seeding"),
        input.plan,
      );
      return {
        ok: true,
        value: previewSnapshotFromRow(next, mailboxOf(input.plan)),
      };
    }
    case "running":
    case "starting": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await patchAccept(
        deps,
        row,
        planAcceptBringUp(row, input, status.value),
        input.plan,
      );
      return {
        ok: true,
        value: previewSnapshotFromRow(next, mailboxOf(input.plan)),
      };
    }
    case "provisioning": {
      const identity = requireDbIdentity(row, input, requestedDbName);
      if (!identity.ok) return identity;
      const next = await patchAccept(
        deps,
        row,
        {
          status: "provisioning",
          plan: "full_replace",
          remint: true,
          hostname: input.hostname,
        },
        input.plan,
      );
      return {
        ok: true,
        value: previewSnapshotFromRow(next, mailboxOf(input.plan)),
      };
    }
  }
}

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
  return completeBringUp(deps, row, input);
}

type DestroyDisposition = "tombstone" | "purge";

/** Must run inside withPreviewLock; never unlock between DROP and finalize. */
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

  try {
    await deps.app.remove(existing.slug, existing.prId);
  } catch {
    console.warn(
      `preview container remove failed for ${existing.slug} pr=${prId}; continuing with DROP`,
    );
  }

  // Previews without a named resource skip the catalog lock and drop call;
  // a named resource holds the lock through DROP and finalize.
  async function finalizeDestroy(): Promise<Result<TeardownSnapshot>> {
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
  }

  if (existing.dbName == null) {
    return finalizeDestroy();
  }

  const dbName = existing.dbName;
  return withDbNameLock(dbName, async () => {
    try {
      await deps.previewDb
        .forDrop(storedProvider(existing))
        .dropDatabase(dbName);
    } catch {
      await markPreviewFailed(deps.db, repo, prId, "preview_db_drop_failed");
      return { ok: false as const, status: 500, error: "preview_db_drop_failed" };
    }
    return finalizeDestroy();
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

/** Pull stays outside the lock so a hung registry cannot stall teardown. */
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

/** Purge holds one lock throughout; confirm binds (repo, prId) only, unversioned. */
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
    await deps.previewDb.forDrop(undefined).dropDatabase(dbName);
    return true;
  });
}
