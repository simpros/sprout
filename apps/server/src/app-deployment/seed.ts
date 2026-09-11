import type { PreviewEnvMap } from "@sprout/preview-env";
import {
  pgConnectionEnv,
  withGatewayConnectionEnv,
  type AppDeployPg,
} from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { seedImageRunName } from "../preview/naming.ts";

/** Request-shape seed fields (image + user env/args). Runtime ids added at run. */
export type SeedImageSpec = {
  image: string;
  env: string[];
  args: string[];
};

export type SeedImageInput = SeedImageSpec & {
  slug: string;
  prId: number;
  dbName: string;
  /** Same deploy-request connectionEnv remap as the app container. */
  connectionEnv?: PreviewEnvMap;
};

/** Lines captured before the one-shot seed container is removed. */
const SEED_LOG_TAIL = 10_000;

/** Mirrors ContainerWaitResult discrimination; exitCode null = Docker ops failure. */
export type SeedImageResult =
  | { ok: true }
  | { ok: false; timedOut: true; logs: string }
  | { ok: false; timedOut: false; exitCode: number | null; logs: string };

export type RunSeedImageDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: { postgres: string };
  seedTimeoutMs: number;
};

async function captureSeedLogs(
  docker: PreviewDocker,
  name: string,
): Promise<string> {
  try {
    return (await docker.containerLogs(name, { tail: SEED_LOG_TAIL })) ?? "";
  } catch {
    return "";
  }
}

/**
 * Run the adopter seed image once on the Postgres network only.
 * Gateway connection keys replace colliding user `--seed-env` keys
 * (PG* or remapped names) so adopters cannot retarget the DB.
 * Never sets Entrypoint — image default entrypoint owns seed logic.
 * Docker ops errors are absorbed into SeedImageResult (never throw mid-phase).
 * Failure logs are always captured while the container still exists, then removed.
 */
export async function runSeedImage(
  deps: RunSeedImageDeps,
  input: SeedImageInput,
): Promise<SeedImageResult> {
  const name = seedImageRunName(input.slug, input.prId);
  try {
    await deps.docker.removeByName(name);

    // Spec: log key count only — never values (may contain secrets).
    console.log("seed:env", input.env.length);

    const { id } = await deps.docker.createAndStart({
      name,
      image: input.image,
      env: withGatewayConnectionEnv(
        input.env,
        pgConnectionEnv(deps.pg, input.dbName, input.connectionEnv),
      ),
      labels: {},
      networkNames: [deps.networks.postgres],
      ...(input.args.length > 0 ? { cmd: input.args } : {}),
    });

    let outcome: SeedImageResult;
    try {
      const wait = await deps.docker.waitForExit(id, deps.seedTimeoutMs);
      if (!wait.timedOut && wait.exitCode === 0) {
        outcome = { ok: true };
      } else {
        const logs = await captureSeedLogs(deps.docker, name);
        outcome = wait.timedOut
          ? { ok: false, timedOut: true, logs }
          : { ok: false, timedOut: false, exitCode: wait.exitCode, logs };
      }
    } catch {
      // waitForExit threw (Engine error / missing StatusCode): capture before remove.
      const logs = await captureSeedLogs(deps.docker, name);
      outcome = { ok: false, timedOut: false, exitCode: null, logs };
    }

    try {
      await deps.docker.removeByName(name);
    } catch {
      console.warn(`seed image remove failed for ${name}`);
    }
    return outcome;
  } catch {
    // create never started (or pre-create remove failed): nothing to capture.
    try {
      await deps.docker.removeByName(name);
    } catch {
      /* best-effort scrub */
    }
    return { ok: false, timedOut: false, exitCode: null, logs: "" };
  }
}
