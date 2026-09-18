import type { PreviewEnvMap } from "@sprout/preview-env";
import type { HealthSpec } from "@sprout/preview-env";
import type {
  PreviewAppOps,
  PreviewServiceSpec,
} from "../app-deployment/ops.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";

export type PreviewStatus =
  | "provisioning"
  | "starting"
  | "seeding"
  | "running"
  | "failed"
  | "removing"
  | "removed";

export type BringUpPlan =
  | "seed_resume"
  | "sync_close"
  | "close"
  | "full_replace";

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
  health: HealthSpec;
  seed?: SeedImageSpec;
  appEnv: string[];
  services?: PreviewServiceSpec[];
  connectionEnv?: PreviewEnvMap;
  reseed?: boolean;
};

export type TeardownInput = {
  repo: string;
  prId: number;
};

export type RemovePreviewInput = {
  repo: string;
  prId: number;
  expectedDbName: string;
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
  last_error?: string;
  last_error_detail?: string;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};
