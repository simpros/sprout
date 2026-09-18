import type { DbSpec, PreviewEnvMap } from "@sprout/preview-env";
import { withGatewayConnectionEnv } from "./pg-env.ts";
import type { AppDeployPg } from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { seedImageRunName } from "../preview/naming.ts";
import { resolveRuntime, type PreviewRuntime } from "../preview/runtime.ts";

export type SeedImageSpec = {
  image: string;
  env: string[];
  args: string[];
};

export type SeedImageInput = SeedImageSpec & {
  slug: string;
  prId: number;
  dbName: string;
  db?: DbSpec;
  connectionEnv?: PreviewEnvMap;
};

const SEED_LOG_TAIL = 10_000;

export type SeedImageResult =
  | { ok: true }
  | { ok: false; timedOut: true; logs: string }
  | { ok: false; timedOut: false; exitCode: number | null; logs: string };

export type RunSeedImageDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: { traefik: string; postgres: string };
  seedTimeoutMs: number;
  runtime?: PreviewRuntime;
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

/** Never throws: Docker ops errors are absorbed into SeedImageResult. */
export async function runSeedImage(
  deps: RunSeedImageDeps,
  input: SeedImageInput,
): Promise<SeedImageResult> {
  const name = seedImageRunName(input.slug, input.prId);
  try {
    await deps.docker.removeByName(name);

    // Log key count only, never values (may contain secrets).
    console.log("seed:env", input.env.length);

    const runtime = resolveRuntime(deps);
    const volumes = runtime.volumes(input.db, input.slug, input.prId);

    const { id } = await deps.docker.createAndStart({
      name,
      image: input.image,
      env: withGatewayConnectionEnv(
        input.env,
        runtime.connectionEnv(input.db, input.dbName, input.connectionEnv),
      ),
      labels: {},
      networkNames: runtime.seedNetworks(input.db),
      ...(volumes.length > 0 ? { volumes } : {}),
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
    try {
      await deps.docker.removeByName(name);
    } catch {
    }
    return { ok: false, timedOut: false, exitCode: null, logs: "" };
  }
}
