import { createHash } from "node:crypto";
import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import type { SproutSeed } from "../yaml.ts";
import { buildAndPush } from "./image-build.ts";

/** Hex chars kept from the seed-content sha256 for the tag suffix. */
export const SEED_TAG_HASH_LEN = 12;

export type SeedContent = { path: string; content: string };

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

/** Scoped push credentials can only write under the project's own repository. */
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

export function resolveCommitSeedImageRef(
  appImageRef: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef);
  if (!repo.ok) return repo;
  return { ok: true, value: `${appImageRef}-seed` };
}

export function resolveContentSeedImageRef(
  appImageRef: string,
  shortHash: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef);
  if (!repo.ok) return repo;
  return { ok: true, value: `${repo.value}:seed-${shortHash}` };
}

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

/** Any non-zero exit reads as not reusable, so the caller builds + pushes. */
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

export type SeedTarget = { ref: string; allowReuse: boolean };

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
