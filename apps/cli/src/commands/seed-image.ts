import { createHash } from "node:crypto";
import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import type { SproutSeed } from "../yaml.ts";

/** Hex chars kept from the seed-content sha256 for the tag suffix. */
export const SEED_TAG_HASH_LEN = 12;

/**
 * Package manifest / lockfile candidates for the default reuse key. Only
 * files present in the repo feed the hash (absent names are skipped), so
 * Bun/npm/yarn/pnpm adopters all get a working default without config.
 */
export const DEFAULT_SEED_LOCKFILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

/**
 * Default reuse key when `seed.inputs` is absent: the seed Dockerfile plus
 * whichever manifest / lockfile is present. Covers the common "deps changed
 * → new image" case; repos whose seed depends on more (entrypoint, seed
 * script, migrations) should set `seed.inputs` explicitly.
 */
export function defaultSeedInputs(dockerfile: string): string[] {
  return [dockerfile, ...DEFAULT_SEED_LOCKFILES];
}

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
 * Derive the seed tag from the app tag's repository plus the content hash:
 * `<registry-path>:seed-<shorthash>` (same repository, distinct tag).
 * Scoped push credentials (GitLab `CI_JOB_TOKEN`, least-privilege registry
 * credentials) can only write under the project's own repository, so a
 * sibling `-seed` repository path is denied — the suffix shape must stay a
 * tag suffix (#148). The app tag always comes from the pipeline convention
 * (`CI_REGISTRY_IMAGE` + SHA), so it always carries a `:tag` suffix.
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
 * Read the reuse-key files for hashing. Explicit `seed.inputs` are all
 * required (a missing entry fails before any docker work); default
 * candidates are best-effort except the seed Dockerfile itself (missing →
 * fail fast instead of a cryptic `docker build` error). Paths resolve
 * against the workspace root (`app_context`); `readFile` is the
 * `deps.readTextFile` seam so tests hash fixture strings.
 */
export async function readSeedContents(
  seed: SproutSeed,
  cwd: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<Result<SeedContent[]>> {
  const explicit = seed.inputs !== undefined;
  const candidates: string[] = explicit
    ? (seed.inputs ?? [])
    : defaultSeedInputs(seed.dockerfile);
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
      if (explicit || rel === seed.dockerfile) {
        return { ok: false, error: `seed input not readable: ${rel}` };
      }
      continue;
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
export async function seedImageExists(
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
