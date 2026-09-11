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
import type { BringUpPlan } from "./types.ts";

export type SeedPhaseDeps = {
  db: StateDb;
  app: Pick<PreviewAppOps, "runSeed">;
};

/**
 * Request-scoped deploy fields that are not persisted on the preview row.
 * seed and connectionEnv are siblings — do not hitch connectionEnv onto SeedImageSpec.
 * Whether to seed is answered by seeded_at on the row (lifecycle clears it
 * after healthy attach for replace+reseed; runSeedPhase clears on entry).
 * fleetPending selects close vs sync_close after promote/seed success.
 */
export type DeployEphemerals = {
  seed?: SeedImageSpec;
  connectionEnv?: PreviewEnvMap;
  /** True when ProvisionInput.services is defined (set or clear queued). */
  fleetPending?: boolean;
};

function planAfterPromote(fleetPending: boolean | undefined): BringUpPlan {
  return fleetPending === true ? "sync_close" : "close";
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
 * Seed phase ownership: enter seeding → run → seededAt + close|sync_close |
 * failed(keep container). Bring-up syncs companions (if sync_close) then
 * closes to `running`. Any post-enter throw still markStickyPreviewFailed
 * so the row cannot tombstone as seeding.
 */
async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals & { seed: SeedImageSpec },
): Promise<Result<true>> {
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
    await updatePreviewRow(
      deps.db,
      row,
      {
        // Stay seeding until bring-up closes to running (after optional sync).
        status: "seeding",
        seededAt,
        // Durable: sync_close only when fleet work is queued; else close.
        bringUpPlan: planAfterPromote(ephemerals.fleetPending),
        lastError: null,
        lastErrorDetail: null,
        failureFamily: null,
        seedLog: null,
        updatedAt: seededAt,
      },
      "preview_row_missing_on_seeded",
    );
    return { ok: true, value: true };
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
 * After-healthy hook entry: no seed → mark close|sync_close; else run seed.
 * Does not write `running` — bring-up owns that after optional companion sync.
 * Seed image is the only after-healthy hook impl in v0.1.
 */
export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  ephemerals: DeployEphemerals = {},
): Promise<Result<true>> {
  const { seed } = ephemerals;
  // Lifecycle clears seeded_at before promote for replace+reseed; this gate
  // stays dumb on row state.
  const shouldSeed = seed !== undefined && starting.seededAt == null;

  if (shouldSeed && seed) {
    return runSeedPhase(deps, starting, { ...ephemerals, seed });
  }

  await updatePreviewRow(
    deps.db,
    starting,
    {
      bringUpPlan: planAfterPromote(ephemerals.fleetPending),
      updatedAt: utcIsoNow(),
    },
    "preview_row_missing_on_promote",
  );
  return { ok: true, value: true };
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
): Promise<Result<true>> {
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
