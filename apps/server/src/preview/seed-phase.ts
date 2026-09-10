import type { PreviewEnvMap } from "@sprout/preview-env";
import { and, eq } from "drizzle-orm";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { SeedImageResult, SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type { Result } from "./result.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";

export type SeedPhaseDeps = {
  db: StateDb;
  app: Pick<PreviewAppOps, "runSeed">;
};

/**
 * Request-scoped deploy fields that are not persisted on the preview row.
 * seed and connectionEnv are siblings — do not hitch connectionEnv onto SeedImageSpec.
 */
export type DeployEphemerals = {
  seed?: SeedImageSpec;
  connectionEnv?: PreviewEnvMap;
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
    .set({
      status: "failed",
      lastError: "seed_failed",
      lastErrorDetail: null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

/**
 * Seed phase ownership: enter seeding → run → running+seededAt | failed(keep container).
 * Any post-enter throw still markSeedFailed so the row cannot tombstone as seeding.
 */
async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals & { seed: SeedImageSpec },
): Promise<Result<SeedPhaseSnapshot>> {
  const { seed, connectionEnv } = ephemerals;
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
      connectionEnv,
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
      {
        status: "running",
        seededAt,
        lastError: null,
        lastErrorDetail: null,
        updatedAt: seededAt,
      },
      "preview_row_missing_on_seeded_running",
    );
    return { ok: true, value: toRunningSnapshot(updated) };
  } catch (err) {
    console.warn("seed:failed", err);
    await markSeedFailed(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "seed_failed" };
  }
}

/**
 * After-healthy hook entry: no seed → running; else run seed phase.
 * Seed image is the only after-healthy hook impl in v0.1.
 */
export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  ephemerals: DeployEphemerals = {},
): Promise<Result<SeedPhaseSnapshot>> {
  const { seed } = ephemerals;
  const shouldSeed =
    seed !== undefined &&
    (starting.seededAt === null || starting.seededAt === undefined);

  if (shouldSeed && seed) {
    return runSeedPhase(deps, starting, { ...ephemerals, seed });
  }

  const updated = await updatePreviewRow(
    deps.db,
    starting,
    {
      status: "running",
      lastError: null,
      lastErrorDetail: null,
      updatedAt: utcIsoNow(),
    },
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
  ephemerals: DeployEphemerals,
): Promise<Result<SeedPhaseSnapshot>> {
  if (!ephemerals.seed) {
    // Keep containerId so the healthy app stays reclaimable for a seeded retry.
    await deps.db
      .update(previews)
      .set({
        status: "failed",
        lastError: "seed_image_required_to_resume_seeding",
        lastErrorDetail: null,
        updatedAt: utcIsoNow(),
      })
      .where(
        and(
          eq(previews.canonicalRepoId, row.canonicalRepoId),
          eq(previews.prId, row.prId),
        ),
      );
    return {
      ok: false,
      status: 422,
      error: "seed_image_required_to_resume_seeding",
    };
  }
  return runSeedPhase(deps, row, {
    ...ephemerals,
    seed: ephemerals.seed,
  });
}
