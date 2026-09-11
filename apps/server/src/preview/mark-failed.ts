import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { utcIsoNow } from "./row.ts";

/**
 * Pre-healthy / ensure / drop failure: clear containerId so Traefik orphans
 * are not claimed. Callers that run outside a held preview lock (background
 * catch) must wrap with withPreviewLock and skip `removing` / `removed` so
 * teardown cannot be resurrected.
 * Do not use for post-healthy sticky failure — see {@link markStickyPreviewFailed}.
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
      failureFamily: null,
      bringUpPlan: null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

export type StickyFailureFamily = "seed_incomplete" | "post_healthy";

export type StickyPreviewFailure = {
  error: string;
  /** Classifies sticky failed for accept → bringUpPlan. */
  family: StickyFailureFamily;
  detail?: string | null;
  /** Captured seed container stdout/stderr; omit to leave seed_log unchanged. */
  seedLog?: string | null;
};

/**
 * Post-healthy sticky failure (seed / companion sync): keep containerId so the
 * routable app stays reclaimable. Clears bringUpPlan; accept writes a fresh
 * plan from {@link StickyFailureFamily} + request (not lastError strings).
 */
export async function markStickyPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
  failure: StickyPreviewFailure,
): Promise<void> {
  await db
    .update(previews)
    .set({
      status: "failed",
      lastError: failure.error,
      lastErrorDetail: failure.detail ?? null,
      failureFamily: failure.family,
      bringUpPlan: null,
      ...(failure.seedLog !== undefined
        ? { seedLog: failure.seedLog === "" ? null : failure.seedLog }
        : {}),
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}
