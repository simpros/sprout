import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The barrel trim recurs whenever a barrel entry outlives its last consumer,
// so every name a package barrel exposes must be imported from the package
// specifier somewhere outside the owning package. Scope is derived from each
// package's package.json "exports", so newly added packages are covered.
interface Barrel {
  specifier: string;
  file: string;
  packageDir: string;
}

function packageBarrels(): Barrel[] {
  const barrels: Barrel[] = [];
  const packagesDir = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = `packages/${entry.name}`;
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, packageDir, "package.json"), "utf8"),
    ) as { name?: unknown; exports?: unknown };
    if (typeof pkg.name !== "string") continue;
    if (typeof pkg.exports !== "object" || pkg.exports === null) continue;
    for (const [subpath, target] of Object.entries(
      pkg.exports as Record<string, unknown>,
    )) {
      const entryPoint =
        typeof target === "string"
          ? target
          : (target as Record<string, unknown>).default ??
            (target as Record<string, unknown>).types;
      if (typeof entryPoint !== "string") continue;
      barrels.push({
        specifier:
          subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`,
        file: join(packageDir, entryPoint),
        packageDir,
      });
    }
  }
  return barrels;
}

function splitNames(list: string): string[] {
  const names: string[] = [];
  for (const part of list.split(",")) {
    const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
    if (name !== "") names.push(name);
  }
  return names;
}

function resolveRelative(rel: string): string {
  if (rel.endsWith(".ts")) return rel;
  try {
    readFileSync(join(repoRoot, `${rel}.ts`));
    return `${rel}.ts`;
  } catch {
    return join(rel, "index.ts");
  }
}

// Names the barrel file exposes: its export-list entries (re-exports and
// local names alike) plus its own top-level export declarations. Star
// re-exports are expanded so new barrel shapes stay covered.
function barrelSurface(rel: string, seen: Set<string>): Set<string> {
  if (seen.has(rel)) return new Set();
  seen.add(rel);
  const text = readFileSync(join(repoRoot, rel), "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(
    /^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm,
  )) {
    for (const name of splitNames(match[1])) names.add(name);
  }
  for (const match of text.matchAll(
    /^\s*export\s+(?:async\s+)?(?:const|let|var|function|class|interface|enum|type)\s+([A-Za-z0-9_]+)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(
    /^\s*export\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z0-9_]+)?\s*from\s*["']([^"']+)["']/gm,
  )) {
    if (match[1].startsWith(".")) {
      for (const name of barrelSurface(
        resolveRelative(join(dirname(rel), match[1])),
        seen,
      )) {
        names.add(name);
      }
    }
  }
  return names;
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Names imported from the barrel specifier via `import { … } from` or
// `export { … } from` in files outside the owning package. Matching the
// import construct (rather than bare identifiers) keeps comments, strings,
// and test titles from counting as consumers.
function specifierConsumers(barrel: Barrel, candidates: string[]): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRegExp(barrel.specifier)}["']`,
    "g",
  );
  for (const file of candidates) {
    if (file === barrel.file || file.startsWith(`${barrel.packageDir}/`)) {
      continue;
    }
    const text = readFileSync(join(repoRoot, file), "utf8");
    for (const match of text.matchAll(pattern)) {
      for (const name of splitNames(match[1])) names.add(name);
    }
  }
  return names;
}

describe("barrel surface", () => {
  test("every barrel export has a consumer outside its package", () => {
    const candidates = git([
      "grep",
      "-l",
      "--fixed-strings",
      "--",
      'from "@sprout/',
      "--",
      "*.ts",
    ])
      .split("\n")
      .filter((f) => f !== "");
    const dead: string[] = [];
    for (const barrel of packageBarrels()) {
      const surface = barrelSurface(barrel.file, new Set());
      const used = specifierConsumers(barrel, candidates);
      for (const name of [...surface].sort()) {
        if (!used.has(name)) dead.push(`${barrel.specifier}: ${name}`);
      }
    }
    expect(dead).toEqual([]);
  });
});
