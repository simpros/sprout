import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Scope: library packages published through a package exports map. Derived
// from manifests so adding a library widens the invariant instead of hiding
// behind a literal; apps stay out because they are deployable binaries.
function scopedDirs(): string[] {
  const out = git(["ls-files", "--", "packages/*/package.json"])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  const dirs: string[] = [];
  for (const rel of out) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        exports?: unknown;
      };
      if (pkg.exports == null) continue;
      const m = rel.match(/^(packages\/[^/]+)\/package\.json$/);
      if (m) dirs.push(`${m[1]}/src`);
    } catch {
      // Unparseable manifest contributes no scope.
    }
  }
  // Fail closed: a scope that silently collapses to nothing would make the
  // dead-export check vacuously green.
  if (dirs.length === 0) {
    throw new Error("dead-exports guard: no exported packages found");
  }
  return dirs.sort();
}

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

type Decl = { name: string; home: string };
type Forward = { file: string; exported: string; source: string; target: string };
type StarForward = { file: string; target: string };
type ImportSite = { file: string; name: string; target: string | null };

function exportTarget(pkgDir: string, entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry != null && typeof entry === "object") {
    const conds = entry as Record<string, unknown>;
    for (const key of ["default", "types", "import", "require"]) {
      const v = exportTarget(pkgDir, conds[key]);
      if (v) return v;
    }
    for (const v of Object.values(conds)) {
      const r = exportTarget(pkgDir, v);
      if (r) return r;
    }
  }
  return null;
}

function packageTable(): Map<string, { dir: string; exportsMap: Map<string, string> }> {
  const map = new Map<string, { dir: string; exportsMap: Map<string, string> }>();
  for (const rel of git(["ls-files", "--", "apps/*/package.json", "packages/*/package.json"])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "")) {
    const m = rel.match(/^((?:apps|packages)\/[^/]+)\/package\.json$/);
    if (!m) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        name?: string;
        exports?: unknown;
      };
      if (typeof pkg.name !== "string") continue;
      const exportsMap = new Map<string, string>();
      const raw = pkg.exports;
      if (typeof raw === "string") {
        exportsMap.set(".", raw);
      } else if (raw != null && typeof raw === "object") {
        for (const [subpath, entry] of Object.entries(raw as Record<string, unknown>)) {
          const target = exportTarget(m[1], entry);
          if (target) exportsMap.set(subpath, target);
        }
      }
      map.set(pkg.name, { dir: m[1], exportsMap });
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
  pkgs: Map<string, { dir: string; exportsMap: Map<string, string> }>,
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
  const pkg = pkgs.get(m[1]);
  if (!pkg) return null;
  const subpath = m[2] == null ? "." : `.${m[2]}`;
  const mapped = pkg.exportsMap.get(subpath);
  if (mapped) {
    const base = normalize(join(pkg.dir, mapped)).replace(/\\/g, "/");
    const hit = candidates(base).find((c) => tracked.has(c));
    if (hit) return hit;
  }
  // Convention fallback for subpaths without an exports entry.
  if (subpath !== ".") {
    const base = `${pkg.dir}/src${subpath}`;
    return candidates(base).find((c) => tracked.has(c)) ?? null;
  }
  return candidates(`${pkg.dir}/src/index.ts`).find((c) => tracked.has(c)) ?? null;
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

// AST walk: every export and import shape the compiler accepts is understood,
// so an unfamiliar shape can never green-light rot or red-light an unrelated
// PR. Namespace imports and namespace re-exports act as wildcards.
function collectFile(
  rel: string,
  source: ts.SourceFile,
  inScope: boolean,
  decls: Decl[],
  imports: { name: string; spec: string }[],
  forwards: { exported: string; source: string; spec: string }[],
  stars: string[],
): void {
  const hasExport = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      (mod) => mod.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) imports.push({ name: "default", spec: spec.text });
      const bindings = clause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        imports.push({ name: "*", spec: spec.text });
      } else {
        for (const el of bindings.elements) {
          imports.push({
            name: (el.propertyName ?? el.name).text,
            spec: spec.text,
          });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec != null && !ts.isStringLiteral(spec)) continue;
      const clause = stmt.exportClause;
      if (clause == null) {
        // export * from "…" — namespace re-exports land here too.
        if (spec != null && ts.isStringLiteral(spec)) stars.push(spec.text);
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        if (spec != null && ts.isStringLiteral(spec)) stars.push(spec.text);
        continue;
      }
      for (const el of clause.elements) {
        const exported = el.name.text;
        const sourceName = (el.propertyName ?? el.name).text;
        if (spec != null && ts.isStringLiteral(spec)) {
          forwards.push({ exported, source: sourceName, spec: spec.text });
        } else if (inScope) {
          decls.push({ name: exported, home: rel });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      if (inScope) decls.push({ name: "default", home: rel });
      continue;
    }
    if (!inScope) continue;
    if (!hasExport(stmt)) continue;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.push({ name: d.name.text, home: rel });
      }
    } else if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      const name = stmt.name?.text;
      if (name) decls.push({ name, home: rel });
      if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        decls.push({ name: "default", home: rel });
      }
    }
  }
}

function collectDead(): { dead: string[]; total: number } {
  const files = trackedTsFiles();
  const tracked = new Set(files);
  const pkgs = packageTable();
  const dirs = scopedDirs();
  const inScope = (f: string): boolean =>
    !f.endsWith(".test.ts") && dirs.some((d) => f === d || f.startsWith(`${d}/`));

  const graph: Graph = { declHome: new Map(), forwards: [], stars: [] };
  const imports: ImportSite[] = [];
  // The graph spans every tracked file so re-export chains through
  // out-of-scope surfaces (notably @sprout/server/api-type) resolve;
  // only scoped homes are reported dead below.
  const scopedDeclKeys: string[] = [];
  const scopedForwards: Forward[] = [];
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const decls: Decl[] = [];
    const fileImports: { name: string; spec: string }[] = [];
    const fileForwards: { exported: string; source: string; spec: string }[] = [];
    const fileStars: string[] = [];
    collectFile(rel, source, true, decls, fileImports, fileForwards, fileStars);
    for (const s of fileImports) {
      imports.push({ file: rel, name: s.name, target: resolveSpec(s.spec, rel, tracked, pkgs) });
    }
    for (const d of decls) graph.declHome.set(`${rel}::${d.name}`, rel);
    for (const f of fileForwards) {
      graph.forwards.push({
        file: rel,
        exported: f.exported,
        source: f.source,
        target: resolveSpec(f.spec, rel, tracked, pkgs),
      });
    }
    for (const spec of fileStars) {
      graph.stars.push({ file: rel, target: resolveSpec(spec, rel, tracked, pkgs) });
    }
    if (!inScope(rel)) continue;
    for (const d of decls) scopedDeclKeys.push(`${rel}::${d.name}`);
    for (const f of fileForwards) {
      scopedForwards.push({
        file: rel,
        exported: f.exported,
        source: f.source,
        target: resolveSpec(f.spec, rel, tracked, pkgs),
      });
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
  for (const key of scopedDeclKeys) {
    const home = graph.declHome.get(key)!;
    const name = key.slice(home.length + 2);
    if (!importerOf(name, home)) dead.push(`${home}: ${name} has no importer outside its home module`);
  }
  const total = scopedDeclKeys.length + scopedForwards.length;
  for (const f of scopedForwards) {
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
    // Reaching here with a non-empty export set proves the scan above
    // actually inspected exports.
    expect(collectDead().total).toBeGreaterThan(0);
  });
});
