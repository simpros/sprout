import { createHash } from "node:crypto";
import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import type { SproutSeed } from "../yaml.ts";
import { buildAndPush } from "./image-build.ts";

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
 * Single validator for both seed tag policies: the app tag always comes
 * from the pipeline convention (`CI_REGISTRY_IMAGE` + SHA), so it always
 * carries a `:tag` suffix. Returns the repository prefix (everything before
 * the last `:`); scoped push credentials (GitLab `CI_JOB_TOKEN`,
 * least-privilege registry credentials) can only write under the project's
 * own repository, so both seed shapes stay on that prefix (#148).
 */
function splitTaggedImageRef(appImageRef: string): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive seed image ref from ${appImageRef}`,
    };
  }
  return { ok: true, value: appImageRef.slice(0, cut) };
}

/**
 * Commit-scoped seed tag (no `seed.inputs`): `<app-tag>-seed` on the same
 * repository. Unique per commit, never reused across commits.
 */
export function resolveCommitSeedImageRef(
  appImageRef: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef);
  if (!repo.ok) return repo;
  return { ok: true, value: `${appImageRef}-seed` };
}

/**
 * Content-addressed seed tag (explicit `seed.inputs`):
 * `<registry-path>:seed-<shorthash>` on the same repository, distinct tag.
 */
export function resolveContentSeedImageRef(
  appImageRef: string,
  shortHash: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef);
  if (!repo.ok) return repo;
  return { ok: true, value: `${repo.value}:seed-${shortHash}` };
}

/**
 * Read the reuse-key files for hashing: the seed Dockerfile plus every
 * explicit `seed.inputs` entry (deduplicated), all required. A missing or
 * unreadable entry fails before any docker work, as does a path that
 * escapes the workspace root. Paths resolve against the workspace root
 * (`app_context`); `readFile` is the `deps.readTextFile` seam so tests
 * hash fixture strings. Callers only reach here on the content-addressed
 * arm — reuse is opt-in on explicit `seed.inputs`.
 */
export async function readSeedContents(
  seed: { dockerfile: string; inputs: string[] },
  cwd: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<Result<SeedContent[]>> {
  const candidates = [
    seed.dockerfile,
    ...seed.inputs.filter((rel) => rel !== seed.dockerfile),
  ];
  const out: SeedContent[] = [];
  for (const rel of candidates) {
    if (
      rel.startsWith("/") ||
      rel === ".." ||
      rel.startsWith("../") ||
      rel.includes("/../") ||
      rel.endsWith("/..")
    ) {
      return { ok: false, error: `seed input escapes workspace: ${rel}` };
    }
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

/** Resolved seed policy: which tag to realize, and whether a probe may skip the build. */
export type SeedTarget = { ref: string; allowReuse: boolean };

/**
 * Policy resolution (no docker): commit-scoped tag without `seed.inputs`
 * (never reusable), content-addressed tag with them (reusable on probe hit).
 * Unreadable inputs and unresolvable refs fail here, before any docker work.
 */
export async function resolveSeedTarget(
  seed: SproutSeed,
  appImageRef: string,
  cwd: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<Result<SeedTarget>> {
  if (seed.inputs === undefined) {
    const ref = resolveCommitSeedImageRef(appImageRef);
    if (!ref.ok) return ref;
    return { ok: true, value: { ref: ref.value, allowReuse: false } };
  }
  const contents = await readSeedContents(
    { dockerfile: seed.dockerfile, inputs: seed.inputs },
    cwd,
    readFile,
  );
  if (!contents.ok) return contents;
  const ref = resolveContentSeedImageRef(
    appImageRef,
    shortSeedHash(contents.value),
  );
  if (!ref.ok) return ref;
  return { ok: true, value: { ref: ref.value, allowReuse: true } };
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
  const target = await resolveSeedTarget(
    seed,
    appImageRef,
    ctx.deps.cwd,
    ctx.deps.readTextFile,
  );
  if (!target.ok) return target;
  const { ref, allowReuse } = target.value;
  if (allowReuse && (await seedImageExists(ctx, ref))) {
    ctx.deps.io.stdout(`seed image reused: ${ref}`);
    return { ok: true, value: { ref, reused: true } };
  }
  const built = await buildAndPush(ctx, "seed", seed.dockerfile, ref);
  if (!built.ok) return built;
  return { ok: true, value: { ref, reused: false } };
}
