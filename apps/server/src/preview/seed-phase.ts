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
 * Whether to seed is answered by seeded_at on the row (lifecycle clears it
 * after healthy attach for replace+reseed; runSeedPhase clears on entry).
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

/** Short sticky detail for status/CLI — never the seed log blob. */
function seedFailureDetail(
  result: Extract<SeedImageResult, { ok: false }>,
): string | null {
  if (result.timedOut) return "timeout";
  if (result.exitCode != null) return `exit=${result.exitCode}`;
  return null;
}

/** Seed failure: keep containerId so the healthy app stays routable for operators. */
async function markSeedFailed(
  db: StateDb,
  repo: string,
  prId: number,
  detail: string | null,
  /** Captured seed container stdout/stderr (empty → null). */
  logs: string,
): Promise<void> {
  await db
    .update(previews)
    .set({
      status: "failed",
      lastError: "seed_failed",
      lastErrorDetail: detail,
      seedLog: logs === "" ? null : logs,
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
      await markSeedFailed(
        deps.db,
        row.canonicalRepoId,
        row.prId,
        seedFailureDetail(seedResult),
        seedResult.logs,
      );
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
        seedLog: null,
        updatedAt: seededAt,
      },
      "preview_row_missing_on_seeded_running",
    );
    return { ok: true, value: toRunningSnapshot(updated) };
  } catch (err) {
    console.warn("seed:failed", err);
    await markSeedFailed(deps.db, row.canonicalRepoId, row.prId, null, "");
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
  // Lifecycle clears seeded_at before promote for replace+reseed; this gate
  // stays dumb on row state.
  const shouldSeed = seed !== undefined && starting.seededAt == null;

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
      seedLog: null,
      updatedAt: utcIsoNow(),
    },
    "preview_row_missing_on_running",
  );
  return { ok: true, value: toRunningSnapshot(updated) };
}

/**
 * Live same-app structural check: container + matching image+hostname.
 * Compose with status / reseed at accept — does not mean "seed not done."
 */
export function canSeedWithoutAppReplace(
  row: PreviewRow,
  input: {
    appImage: string;
    hostname: string;
    /** Non-empty services force app replace so companions stay in sync. */
    services?: readonly unknown[];
  },
): boolean {
  return (
    row.containerId != null &&
    row.appImage === input.appImage &&
    row.hostname === input.hostname &&
    (input.services?.length ?? 0) === 0
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
