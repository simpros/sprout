import type { PreviewDocker } from "../docker/port.ts";
import { seedImageRunName } from "../preview/naming.ts";

export type SeedImageInput = {
  slug: string;
  prId: number;
  image: string;
  dbName: string;
  /** User `--seed-env` KEY=VALUE entries (PG* appended after). */
  env: string[];
  /** User `--seed-arg` values → Docker Cmd (never Entrypoint). */
  args: string[];
};

export type SeedImageResult =
  | { ok: true }
  | { ok: false; exitCode: number | null; timedOut: boolean };

export type RunSeedImageDeps = {
  docker: PreviewDocker;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  networks: { postgres: string };
  seedTimeoutMs: number;
};

/**
 * Run the adopter seed image once on the Postgres network only.
 * Gateway sets PG* after user env so adopters cannot retarget the DB.
 * Never sets Entrypoint — image default entrypoint owns seed logic.
 */
export async function runSeedImage(
  deps: RunSeedImageDeps,
  input: SeedImageInput,
): Promise<SeedImageResult> {
  const name = seedImageRunName(input.slug, input.prId);
  await deps.docker.removeByName(name);

  // Spec: log key count only — never values (may contain secrets).
  console.log("seed:env", input.env.length);

  const { id } = await deps.docker.createAndStart({
    name,
    image: input.image,
    env: [
      ...input.env,
      `PGHOST=${deps.pg.host}`,
      `PGPORT=${String(deps.pg.port)}`,
      `PGUSER=${deps.pg.user}`,
      `PGPASSWORD=${deps.pg.password}`,
      `PGDATABASE=${input.dbName}`,
    ],
    labels: {},
    networkNames: [deps.networks.postgres],
    ...(input.args.length > 0 ? { cmd: input.args } : {}),
  });

  try {
    const wait = await deps.docker.waitForExit(id, deps.seedTimeoutMs);
    if (wait.timedOut) {
      return { ok: false, exitCode: null, timedOut: true };
    }
    if (wait.exitCode !== 0) {
      return { ok: false, exitCode: wait.exitCode, timedOut: false };
    }
    return { ok: true };
  } finally {
    try {
      await deps.docker.removeByName(name);
    } catch {
      console.warn(`seed image remove failed for ${name}`);
    }
  }
}
