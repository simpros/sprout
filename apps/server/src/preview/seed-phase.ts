import { and, eq } from "drizzle-orm";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { SeedImageResult, SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export type SeedPhaseDeps = {
  db: StateDb;
  app: Pick<PreviewAppOps, "runSeed">;
};

/** Running snapshot returned by seed/promote closers (matches PreviewSnapshot). */
export type SeedPhaseSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: "running";
  preview_url: string;
};

function toRunningSnapshot(row: PreviewRow): SeedPhaseSnapshot {
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: "running",
    preview_url: `https://${row.hostname}`,
  };
}

/** Seed failure: keep containerId so the healthy app stays routable for operators. */
async function markSeedFailed(
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

/**
 * Seed phase ownership: enter seeding → run → running+seededAt | failed(keep container).
 * Any post-enter throw still markSeedFailed so the row cannot tombstone as seeding.
 */
export async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  seed: SeedImageSpec,
): Promise<Result<SeedPhaseSnapshot>> {
  await updatePreviewRow(
    deps.db,
    row,
    { status: "seeding", updatedAt: utcIsoNow() },
    "preview_row_missing_on_seeding",
  );

  try {
    const seedResult: SeedImageResult = await deps.app.runSeed({
      slug: row.slug,
      prId: row.prId,
      image: seed.image,
      dbName: row.dbName,
      env: seed.env,
      args: seed.args,
    });

    if (!seedResult.ok) {
      if (seedResult.timedOut) {
        console.warn("seed:failed", "timeout");
      } else {
        console.warn("seed:failed", seedResult.exitCode);
      }
      await markSeedFailed(deps.db, row.canonicalRepoId, row.prId);
      return { ok: false, status: 500, error: "seed_failed" };
    }

    const seededAt = utcIsoNow();
    const updated = await updatePreviewRow(
      deps.db,
      row,
      { status: "running", seededAt, updatedAt: seededAt },
      "preview_row_missing_on_seeded_running",
    );
    return { ok: true, value: toRunningSnapshot(updated) };
  } catch (err) {
    console.warn("seed:failed", err);
    await markSeedFailed(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "seed_failed" };
  }
}

/** Post-health closer: no seed → running; else seed phase. */
export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  seed?: SeedImageSpec,
): Promise<Result<SeedPhaseSnapshot>> {
  const shouldSeed =
    seed !== undefined &&
    (starting.seededAt === null || starting.seededAt === undefined);

  if (shouldSeed && seed) {
    return runSeedPhase(deps, starting, seed);
  }

  const updated = await updatePreviewRow(
    deps.db,
    starting,
    { status: "running", updatedAt: utcIsoNow() },
    "preview_row_missing_on_running",
  );
  return { ok: true, value: toRunningSnapshot(updated) };
}

/**
 * Live app with seed not done: same image+hostname+container means resume
 * seed only (no Traefik replace). Used for crash-mid-seed and seed-failed.
 */
export function canResumeSeed(
  row: PreviewRow,
  input: { appImage: string; hostname: string },
): boolean {
  return (
    row.containerId != null &&
    row.appImage === input.appImage &&
    row.hostname === input.hostname
  );
}

/**
 * Resume seed-incomplete row without replace. Requires seed_image — otherwise
 * a synchronize without -s would silently mark running with seededAt null.
 */
export async function resumeIncompleteSeed(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  seed: SeedImageSpec | undefined,
): Promise<Result<SeedPhaseSnapshot>> {
  if (!seed) {
    return {
      ok: false,
      status: 422,
      error: "seed_image_required_to_resume_seeding",
    };
  }
  return runSeedPhase(deps, row, seed);
}
