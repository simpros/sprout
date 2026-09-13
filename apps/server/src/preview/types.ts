import type { PreviewEnvMap } from "@sprout/preview-env";
import type { HealthSpec } from "@sprout/preview-env";
import type {
  PreviewAppOps,
  PreviewServiceSpec,
} from "../app-deployment/ops.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";

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

/**
 * Durable bring-up plan on the preview row (accept writes; bring-up consumes).
 * After promote/seed: `sync_close` only when companion fleet work is queued;
 * otherwise `close` (no-op sync → running). Crash mid-fleet cannot re-seed
 * or full-replace a healthy app.
 */
export type BringUpPlan =
  | "seed_resume"
  | "sync_close"
  | "close"
  | "full_replace";

/** Coarse status for list/doctor display (starting/seeding → provisioning). */
export type DisplayPreviewStatus =
  | "provisioning"
  | "running"
  | "failed"
  | "removing"
  | "removed";

export type TeardownDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: Pick<PreviewAppOps, "remove">;
};

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
};

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
  appImage: string;
  /** Resolved at the HTTP/CLI boundary — never defaulted here. */
  health: HealthSpec;
  /** Present when deploy requested a seed image; env/args not persisted. */
  seed?: SeedImageSpec;
  /** Adopter KEY=VALUE for the app container; request-scoped, not persisted. */
  appEnv: string[];
  /**
   * Companion fleet sync; request-scoped, not persisted.
   * `undefined` = leave existing companions; `[]` = clear; non-empty = replace.
   */
  services?: PreviewServiceSpec[];
  /** Connection env name remap; request-scoped, not persisted. */
  connectionEnv?: PreviewEnvMap;
  /**
   * Lifecycle-only: seed-only accept plan when same-app, and clear seeded_at
   * after healthy attach (replace path). Seed-only path clears inside
   * runSeedPhase. Never forwarded into DeployEphemerals.
   */
  reseed?: boolean;
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
  /** Sticky last deploy attempt; independent of phase (e.g. running + pull fail). */
  last_error?: string;
  last_error_detail?: string;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};
