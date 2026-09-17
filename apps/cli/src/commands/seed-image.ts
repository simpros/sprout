import { createHash } from "node:crypto";
import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import type { SproutSeed } from "../yaml.ts";

/** Hex chars kept from the seed-content sha256 for the tag suffix. */
export const SEED_TAG_HASH_LEN = 12;

export type SeedContent = { path: string; content: string };

/**
 * Short content hash over the reuse-key files: entries sorted by path, each
 * path folded into the digest so a rename re-tags even with identical bytes.
 */
export function shortSeedHash(entries: SeedContent[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, SEED_TAG_HASH_LEN);
}

/**
 * Commit-scoped seed tag (no `seed.inputs`): `<app-tag>-seed` on the same
 * repository. The app tag always comes from the pipeline convention
 * (`CI_REGISTRY_IMAGE` + SHA), so it always carries a `:tag` suffix — the
 * seed tag is unique per commit and never reused across commits. Scoped
 * push credentials (GitLab `CI_JOB_TOKEN`, least-privilege registry
 * credentials) can only write under the project's own repository, so the
 * tag-suffix shape must stay a suffix (#148).
 */
export function resolveCommitSeedImageRef(
  appImageRef: string,
): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive seed image ref from ${appImageRef}`,
    };
  }
  return { ok: true, value: `${appImageRef}-seed` };
}

/**
 * Content-addressed seed tag (explicit `seed.inputs`):
 * `<registry-path>:seed-<shorthash>` on the same repository, distinct tag.
 * Same scoped-credential constraint as the commit-scoped shape above.
 */
export function resolveSeedImageRef(
  appImageRef: string,
  shortHash: string,
): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive seed image ref from ${appImageRef}`,
    };
  }
  return {
    ok: true,
    value: `${appImageRef.slice(0, cut)}:seed-${shortHash}`,
  };
}

/**
 * Read the reuse-key files for hashing: the seed Dockerfile plus every
 * explicit `seed.inputs` entry (deduplicated), all required. A missing
 * entry fails before any docker work. Paths resolve against the workspace
 * root (`app_context`); `readFile` is the `deps.readTextFile` seam so tests
 * hash fixture strings. Reuse is opt-in on explicit `seed.inputs` — without
 * them the caller takes the commit-scoped path and never hashes.
 */
export async function readSeedContents(
  seed: SproutSeed,
  cwd: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<Result<SeedContent[]>> {
  const candidates = [
    seed.dockerfile,
    ...(seed.inputs ?? []).filter((rel) => rel !== seed.dockerfile),
  ];
  const out: SeedContent[] = [];
  for (const rel of candidates) {
    let content: string | null;
    try {
      content = await readFile(`${cwd}/${rel}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `seed input not readable: ${rel}: ${detail}` };
    }
    if (content === null) {
      return { ok: false, error: `seed input not readable: ${rel}` };
    }
    out.push({ path: rel, content });
  }
  return { ok: true, value: out };
}

/**
 * Reuse probe: `docker manifest inspect` exits 0 only when the tag exists
 * and the registry auth works. Any non-zero exit — absent tag, network /
 * auth failure, or a docker without `manifest` support — reads as "not
 * reusable", so the caller builds + pushes. A failed check degrades to
 * build+push; only exit 0 skips, so there is never a silent skip.
 */
async function seedImageExists(
  ctx: CliContext,
  ref: string,
): Promise<boolean> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  try {
    const result = await run(["docker", "manifest", "inspect", ref], {
      cwd: ctx.deps.cwd,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * `docker build -f <dockerfile> -t <ref> .` then `docker push <ref>`.
 * The docker CLI inherits the job env, so dind (`DOCKER_HOST`, TLS) and
 * registry auth work unchanged. Build output streams to the job log;
 * only the exit code is captured.
 */
export async function buildAndPush(
  ctx: CliContext,
  label: string,
  dockerfile: string,
  ref: string,
): Promise<Result<true>> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const build = await run(
    ["docker", "build", "-f", dockerfile, "-t", ref, "."],
    { cwd: ctx.deps.cwd },
  );
  if (build.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image build failed (exit ${build.exitCode})`,
    };
  }
  const push = await run(["docker", "push", ref], { cwd: ctx.deps.cwd });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image push failed (exit ${push.exitCode})`,
    };
  }
  return { ok: true, value: true };
}

export type EnsuredSeedImage = { ref: string; reused: boolean };

/**
 * One seam for the seed image: resolve → probe → build/push. Without
 * `seed.inputs` the tag is commit-scoped and the image is always built +
 * pushed (correct, no false reuse). With `seed.inputs` the tag is
 * content-addressed and the build + push is skipped when the tag already
 * exists in the registry (reuse is logged; a failed probe rebuilds, never
 * a silent skip). Failures (unreadable inputs, unresolvable ref, failed
 * build/push) return before the caller deploys.
 */
export async function ensureSeedImage(
  ctx: CliContext,
  seed: SproutSeed,
  appImageRef: string,
): Promise<Result<EnsuredSeedImage>> {
  if (seed.inputs === undefined) {
    const ref = resolveCommitSeedImageRef(appImageRef);
    if (!ref.ok) return ref;
    const built = await buildAndPush(ctx, "seed", seed.dockerfile, ref.value);
    if (!built.ok) return built;
    return { ok: true, value: { ref: ref.value, reused: false } };
  }
  const contents = await readSeedContents(
    seed,
    ctx.deps.cwd,
    ctx.deps.readTextFile,
  );
  if (!contents.ok) return contents;
  const ref = resolveSeedImageRef(appImageRef, shortSeedHash(contents.value));
  if (!ref.ok) return ref;
  if (await seedImageExists(ctx, ref.value)) {
    ctx.deps.io.stdout(`seed image reused: ${ref.value}`);
    return { ok: true, value: { ref: ref.value, reused: true } };
  }
  const built = await buildAndPush(ctx, "seed", seed.dockerfile, ref.value);
  if (!built.ok) return built;
  return { ok: true, value: { ref: ref.value, reused: false } };
}
