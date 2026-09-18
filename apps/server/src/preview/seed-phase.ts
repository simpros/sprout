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

export type DeployEphemerals = {
  seed?: SeedImageSpec;
  connectionEnv?: PreviewEnvMap;
  fleetPending?: boolean;
};

export function isSeedImageChanged(
  row: Pick<PreviewRow, "seededAt" | "seededSeedImage">,
  seedImage: string | undefined,
): boolean {
  if (seedImage === undefined) return false;
  if (row.seededAt == null) return false;
  return row.seededSeedImage !== seedImage;
}

function planAfterPromote(fleetPending: boolean | undefined): BringUpPlan {
  return fleetPending === true ? "sync_close" : "close";
}

function seedFailureDetail(
  result: Extract<SeedImageResult, { ok: false }>,
): string | null {
  if (result.timedOut) return "timeout";
  if (result.exitCode != null) return `exit=${result.exitCode}`;
  return null;
}

async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals & { seed: SeedImageSpec },
): Promise<Result<true>> {
  const { seed, connectionEnv } = ephemerals;
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
        status: "seeding",
        seededAt,
        seededSeedImage: seed.image,
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

export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  ephemerals: DeployEphemerals = {},
): Promise<Result<true>> {
  const { seed } = ephemerals;
  const shouldSeed =
    seed !== undefined &&
    (starting.seededAt == null || isSeedImageChanged(starting, seed.image));

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

export async function resumeIncompleteSeed(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals,
): Promise<Result<true>> {
  if (!ephemerals.seed) {
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
