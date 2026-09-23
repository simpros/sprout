import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Scope: the library packages whose barrel surface the cleanup trimmed to its
// importers. Apps are deployable binaries, not importable surfaces, so the
// invariant is enforced where cross-package imports can rot, not repo-wide.
// The guard lands in the same commit as the trim it certifies.
const SCOPED_DIRS = ["packages/preview-env/src", "packages/preview-db/src"];

// Policy the guard encodes. The barrel is the cross-package surface; home
// modules may additionally export intra-package seams (notably for direct-path
// tests), so the barrel is allowed to be a strict subset of module exports.
// A test import is a legitimate seam: it pins the export deliberately, and the
// seam stays live only while the test names it.
function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `dead-exports guard: git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim();
}

function trackedTsFiles(): string[] {
  // Single tracked-set query; every file is then read once from the working
  // tree, so there is no per-symbol exit-code ambiguity to misread.
  const files = git(["ls-files", "--", "*.ts"])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  // Fail closed: a scope that silently collapses to nothing would make the
  // dead-export check vacuously green.
  if (files.length === 0) {
    throw new Error("dead-exports guard: tracked file scan found no .ts files");
  }
  return files;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("//");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

type Decl = { name: string; home: string };
type Forward = { file: string; exported: string; source: string; target: string };
type StarForward = { file: string; target: string };
type ImportSite = { file: string; name: string; target: string | null };

function parseBraceList(clause: string): { source: string; exported: string }[] {
  const out: { source: string; exported: string }[] = [];
  for (const part of clause.split(",")) {
    const m = part.trim().match(/^(?:type\s+)?([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    out.push({ source: m[1], exported: m[2] ?? m[1] });
  }
  return out;
}

// Import and re-export sites name the symbol; prose, test titles, and the
// barrel's own forwarding lines never count as consumers.
function parseSites(rel: string, text: string): {
  imports: { name: string; spec: string }[];
  forwards: { exported: string; source: string; spec: string }[];
  stars: string[];
} {
  const imports: { name: string; spec: string }[] = [];
  const forwards: { exported: string; source: string; spec: string }[] = [];
  const stars: string[] = [];
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s*(["'])([^"']+)\2/g)) {
    const clause = m[1].trim();
    const spec = m[3];
    const braced = clause.match(/^(?:([A-Za-z0-9_]+)\s*,\s*)?\{([\s\S]*)\}$/);
    if (clause.startsWith("*")) {
      imports.push({ name: "*", spec });
    } else if (braced) {
      if (braced[1]) imports.push({ name: "default", spec });
      for (const e of parseBraceList(braced[2])) imports.push({ name: e.source, spec });
    } else if (/^[A-Za-z0-9_]+$/.test(clause)) {
      imports.push({ name: "default", spec });
    }
    // Anything else cannot name a scoped export, so it cannot hide rot.
  }
  for (const m of text.matchAll(/\bexport\s+([^;]*?)\s+from\s*(["'])([^"']+)\2/g)) {
    const clause = m[1].trim().replace(/^type\s+/, "");
    const spec = m[3];
    if (clause === "*") {
      stars.push(spec);
    } else if (clause.startsWith("{")) {
      const inner = clause.match(/^\{([\s\S]*)\}$/);
      if (!inner) throw new Error(`${rel}: unsupported export shape: ${m[0]}`);
      for (const e of parseBraceList(inner[1])) {
        forwards.push({ exported: e.exported, source: e.source, spec });
      }
    } else {
      throw new Error(`${rel}: unsupported export shape: ${m[0]}`);
    }
  }
  return { imports, forwards, stars };
}

// Declarations are parsed only for files in scope, so an unknown shape fails
// the PR that introduces it — with a pointer — instead of rotting silently.
function parseDecls(rel: string, text: string): string[] {
  const names: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decl =
      line.match(
        /^export\s+(?:async\s+)?(?:const|let|var|function|class|interface|enum|type)\s+([A-Za-z0-9_]+)/,
      ) ?? line.match(/^export\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_]+)/);
    if (decl) {
      names.push(decl[1]);
      continue;
    }
    if (/^export\s/.test(line)) {
      let stmt = line;
      while (
        stmt.includes("{") &&
        !/from\s*["'][^"']+["']/.test(stmt) &&
        i + 1 < lines.length
      ) {
        stmt += "\n" + lines[++i];
      }
      if (/from\s*["'][^"']+["']/.test(stmt)) continue; // re-export, owned by its home module
      const bare = stmt.match(/^export\s+(?:type\s+)?\{([\s\S]*)\}/);
      if (bare) {
        for (const e of parseBraceList(bare[1])) names.push(e.exported);
        continue;
      }
      throw new Error(
        `${rel}: unsupported export shape: ${line.trim()} (extend parseDecls alongside it)`,
      );
    }
  }
  return names;
}

function packageDirs(): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of git(["ls-files", "--", "packages/*/package.json"])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "")) {
    const m = rel.match(/^(packages\/[^/]+)\/package\.json$/);
    if (!m) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        name?: string;
        exports?: Record<string, string>;
      };
      if (typeof pkg.name === "string") map.set(pkg.name, m[1]);
    } catch {
      // Unparseable manifest: bare specifiers to it simply resolve nowhere.
    }
  }
  return map;
}

function resolveSpec(
  spec: string,
  fromFile: string,
  tracked: Set<string>,
  pkgs: Map<string, string>,
): string | null {
  const candidates = (base: string): string[] => {
    if (base.endsWith(".ts")) return [base];
    return [`${base}.ts`, `${base}/index.ts`];
  };
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, "/");
    return candidates(base).find((c) => tracked.has(c)) ?? null;
  }
  const m = spec.match(/^(@[^/]+\/[^/]+)(\/.*)?$/);
  if (!m) return null;
  const dir = pkgs.get(m[1]);
  if (!dir) return null;
  if (!m[2]) {
    return candidates(`${dir}/src/index.ts`).find((c) => tracked.has(c)) ?? null;
  }
  const base = `${dir}/src${m[2]}`;
  return candidates(base).find((c) => tracked.has(c)) ?? null;
}

type Graph = {
  declHome: Map<string, string>;
  forwards: Forward[];
  stars: StarForward[];
};

function provides(graph: Graph, target: string | null, name: string): boolean {
  const seen = new Set<string>();
  const stack: [string | null, string][] = [[target, name]];
  while (stack.length > 0) {
    const [file, want] = stack.pop()!;
    if (file === null || seen.has(`${file}::${want}`)) continue;
    seen.add(`${file}::${want}`);
    if (graph.declHome.get(`${file}::${want}`) === file) return true;
    for (const f of graph.forwards) {
      if (f.file === file && f.exported === want) stack.push([f.target, f.source]);
    }
    for (const s of graph.stars) {
      if (s.file === file) stack.push([s.target, want]);
    }
  }
  return false;
}

function collectDead(): { dead: string[]; total: number } {
  const files = trackedTsFiles();
  const tracked = new Set(files);
  const pkgs = packageDirs();
  const inScope = (f: string): boolean =>
    !f.endsWith(".test.ts") && SCOPED_DIRS.some((d) => f === d || f.startsWith(`${d}/`));

  const graph: Graph = { declHome: new Map(), forwards: [], stars: [] };
  const imports: ImportSite[] = [];
  for (const rel of files) {
    const text = stripComments(readFileSync(join(repoRoot, rel), "utf8"));
    const sites = parseSites(rel, text);
    for (const s of sites.imports) {
      imports.push({ file: rel, name: s.name, target: resolveSpec(s.spec, rel, tracked, pkgs) });
    }
    if (!inScope(rel)) continue;
    for (const d of parseDecls(rel, text)) graph.declHome.set(`${rel}::${d}`, rel);
    for (const f of sites.forwards) {
      graph.forwards.push({
        file: rel,
        exported: f.exported,
        source: f.source,
        target: resolveSpec(f.spec, rel, tracked, pkgs),
      });
    }
    for (const spec of sites.stars) {
      graph.stars.push({ file: rel, target: resolveSpec(spec, rel, tracked, pkgs) });
    }
  }

  const dead: string[] = [];
  const importerOf = (name: string, file: string): boolean =>
    imports.some(
      (s) =>
        s.file !== file &&
        (s.name === name || s.name === "*") &&
        provides(graph, s.target, name),
    );
  for (const [key, home] of graph.declHome) {
    const name = key.slice(home.length + 2);
    if (!importerOf(name, home)) dead.push(`${home}: ${name} has no importer outside its home module`);
  }
  const total = graph.declHome.size + graph.forwards.length;
  for (const f of graph.forwards) {
    if (
      !imports.some(
        (s) => s.file !== f.file && (s.name === f.exported || s.name === "*") && provides(graph, s.target, f.exported),
      )
    ) {
      dead.push(`${f.file}: re-export '${f.exported}' has no importer`);
    }
  }
  return { dead: dead.sort(), total };
}

describe("dead exports", () => {
  test("every export in the preview packages has an importer outside its home module", () => {
    expect(collectDead().dead).toEqual([]);
  });

  test("guard understands every export shape in scope", () => {
    // parseDecls throws on unrecognized shapes, so reaching here with a
    // non-empty export set proves the scan above actually inspected exports.
    expect(collectDead().total).toBeGreaterThan(0);
  });
});
