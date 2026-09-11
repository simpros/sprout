import type { PreviewEnvMap } from "@sprout/preview-env";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { SeedImageResult, SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { markStickyPreviewFailed } from "./mark-failed.ts";
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
 * Whether to seed is answered by seeded_at on the row (lifecycle clears it
 * after healthy attach for replace+reseed; runSeedPhase clears on entry).
 */
export type DeployEphemerals = {
  seed?: SeedImageSpec;
  connectionEnv?: PreviewEnvMap;
};

/**
 * Promote/seed succeeded but the row is not yet `running`.
 * Fleet sync may still follow; bring-up owns the single write to `running`.
 */
export type SeedPhaseSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: "starting" | "seeding";
};

function toPromotedSnapshot(row: PreviewRow): SeedPhaseSnapshot {
  const status = row.status === "seeding" ? "seeding" : "starting";
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status,
  };
}

/** Short sticky detail for status/CLI — never the seed log blob. */
function seedFailureDetail(
  result: Extract<SeedImageResult, { ok: false }>,
): string | null {
  if (result.timedOut) return "timeout";
  if (result.exitCode != null) return `exit=${result.exitCode}`;
  return null;
}

/**
 * Seed phase ownership: enter seeding → run → seededAt (still seeding) |
 * failed(keep container). Bring-up closes to `running` after companion sync.
 * Any post-enter throw still markStickyPreviewFailed so the row cannot
 * tombstone as seeding.
 */
async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals & { seed: SeedImageSpec },
): Promise<Result<SeedPhaseSnapshot>> {
  const { seed, connectionEnv } = ephemerals;
  // Clear seeded_at on entry so a failed reseed matches first-seed failure
  // (null seeded_at) and resume can re-run without another --reseed.
  await updatePreviewRow(
    deps.db,
    row,
    { status: "seeding", seededAt: null, updatedAt: utcIsoNow() },
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
      await markStickyPreviewFailed(
        deps.db,
        row.canonicalRepoId,
        row.prId,
        {
          error: "seed_failed",
          family: "seed_incomplete",
          detail: seedFailureDetail(seedResult),
          seedLog: seedResult.logs,
        },
      );
      return { ok: false, status: 500, error: "seed_failed" };
    }

    const seededAt = utcIsoNow();
    const updated = await updatePreviewRow(
      deps.db,
      row,
      {
        // Stay seeding until bring-up syncs companions and closes to running.
        status: "seeding",
        seededAt,
        lastError: null,
        lastErrorDetail: null,
        failureFamily: null,
        seedLog: null,
        updatedAt: seededAt,
      },
      "preview_row_missing_on_seeded",
    );
    return { ok: true, value: toPromotedSnapshot(updated) };
  } catch (err) {
    console.warn("seed:failed", err);
    await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
      error: "seed_failed",
      family: "seed_incomplete",
      detail: null,
      seedLog: "",
    });
    return { ok: false, status: 500, error: "seed_failed" };
  }
}

/**
 * After-healthy hook entry: no seed → stay starting; else run seed phase.
 * Does not write `running` — bring-up owns that after companion sync.
 * Seed image is the only after-healthy hook impl in v0.1.
 */
export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  ephemerals: DeployEphemerals = {},
): Promise<Result<SeedPhaseSnapshot>> {
  const { seed } = ephemerals;
  // Lifecycle clears seeded_at before promote for replace+reseed; this gate
  // stays dumb on row state.
  const shouldSeed = seed !== undefined && starting.seededAt == null;

  if (shouldSeed && seed) {
    return runSeedPhase(deps, starting, { ...ephemerals, seed });
  }

  // Attach already left status=starting with errors cleared; no DB write.
  return { ok: true, value: toPromotedSnapshot(starting) };
}

/**
 * Live same-app structural check: container + matching image+hostname.
 * Compose with status / reseed at accept — does not mean "seed not done."
 * Service sync is orthogonal (see ProvisionInput.services tri-state).
 */
export function canSeedWithoutAppReplace(
  row: PreviewRow,
  input: {
    appImage: string;
    hostname: string;
  },
): boolean {
  return (
    row.containerId != null &&
    row.appImage === input.appImage &&
    row.hostname === input.hostname
  );
}

/**
 * Resume seed-incomplete row without replace. Requires seed_image — otherwise
 * a synchronize without -s would silently close to running with seededAt null.
 */
export async function resumeIncompleteSeed(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals,
): Promise<Result<SeedPhaseSnapshot>> {
  if (!ephemerals.seed) {
    // Keep containerId so the healthy app stays reclaimable for a seeded retry.
    await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
      error: "seed_image_required_to_resume_seeding",
      family: "seed_incomplete",
      detail: null,
    });
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
