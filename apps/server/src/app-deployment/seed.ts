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
};

/** Mirrors ContainerWaitResult discrimination; exitCode null = Docker ops failure. */
export type SeedImageResult =
  | { ok: true }
  | { ok: false; timedOut: true }
  | { ok: false; timedOut: false; exitCode: number | null };

type SeedPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export type RunSeedImageDeps = {
  docker: PreviewDocker;
  pg: SeedPg;
  networks: { postgres: string };
  seedTimeoutMs: number;
};

/** Five PG* vars for preview DB access (gateway-owned; appended after user env). */
export function pgConnectionEnv(pg: SeedPg, dbName: string): string[] {
  return [
    `PGHOST=${pg.host}`,
    `PGPORT=${String(pg.port)}`,
    `PGUSER=${pg.user}`,
    `PGPASSWORD=${pg.password}`,
    `PGDATABASE=${dbName}`,
  ];
}

/**
 * Run the adopter seed image once on the Postgres network only.
 * Gateway sets PG* after user env so adopters cannot retarget the DB.
 * Never sets Entrypoint — image default entrypoint owns seed logic.
 * Docker ops errors are absorbed into SeedImageResult (never throw mid-phase).
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
      env: [...input.env, ...pgConnectionEnv(deps.pg, input.dbName)],
      labels: {},
      networkNames: [deps.networks.postgres],
      ...(input.args.length > 0 ? { cmd: input.args } : {}),
    });

    try {
      const wait = await deps.docker.waitForExit(id, deps.seedTimeoutMs);
      if (wait.timedOut) {
        return { ok: false, timedOut: true };
      }
      if (wait.exitCode !== 0) {
        return { ok: false, timedOut: false, exitCode: wait.exitCode };
      }
      return { ok: true };
    } finally {
      try {
        await deps.docker.removeByName(name);
      } catch {
        console.warn(`seed image remove failed for ${name}`);
      }
    }
  } catch {
    try {
      await deps.docker.removeByName(name);
    } catch {
      console.warn(`seed image remove failed for ${name}`);
    }
    return { ok: false, timedOut: false, exitCode: null };
  }
}
