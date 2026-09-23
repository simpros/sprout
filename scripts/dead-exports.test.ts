import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Scope: every library package with a barrel (packages/*/src/index.ts).
// Derived from the workspace manifests plus barrel presence so adding a
// library widens the invariant and dropping a manifest field cannot
// silently descope a package; apps stay out because they are deployable
// binaries.
function scopedDirs(
  pkgs: Map<string, { dir: string; exportsMap: Map<string, string> }>,
  tracked: Set<string>,
): string[] {
  const dirs = [...pkgs.values()]
    .map((p) => `${p.dir}/src`)
    .filter((dir) => dir.startsWith("packages/") && tracked.has(`${dir}/index.ts`));
  // Fail closed: a scope that silently collapses to nothing would make the
  // dead-export check vacuously green.
  if (dirs.length === 0) {
    throw new Error("dead-exports guard: no exported packages found");
  }
  // Fail closed per package: a barrel with no manifest entry (missing or
  // unparseable package.json) must shout, not silently leave scope.
  for (const f of tracked) {
    const m = f.match(/^(packages\/[^/]+\/src)\/index\.ts$/);
    if (m && !dirs.includes(m[1])) {
      throw new Error(`dead-exports guard: barrel without scope: ${f}`);
    }
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
type Forward = { file: string; exported: string; source: string; target: string | null };
type StarForward = { file: string; target: string | null };
type ImportSite = { file: string; name: string; target: string | null };

function exportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry != null && typeof entry === "object") {
    const conds = entry as Record<string, unknown>;
    for (const key of ["default", "types", "import", "require"]) {
      const v = exportTarget(conds[key]);
      if (v) return v;
    }
    for (const v of Object.values(conds)) {
      const r = exportTarget(v);
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
          const target = exportTarget(entry);
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
  decls: Decl[];
  forwards: Forward[];
  stars: StarForward[];
};

function homes(graph: Graph, target: string | null, name: string): Set<string> {
  // Every `file::name` pair whose surface provides `name` along the
  // resolution chain — both the declaring home and each barrel that forwards
  // it. Callers seed the walk with the *import site's* name, so a rename
  // anywhere along the chain (`export { X as Y }`) is followed by the BFS
  // instead of discarded by a name gate. Pair-keying keeps it exact: a decl
  // at `home` is live iff some outside import site reaches `home::name`, so
  // a sibling name declared in the same home is never credited.
  const out = new Set<string>();
  const seen = new Set<string>();
  const stack: [string | null, string][] = [[target, name]];
  while (stack.length > 0) {
    const [file, want] = stack.pop()!;
    if (file === null || seen.has(`${file}::${want}`)) continue;
    seen.add(`${file}::${want}`);
    const home = graph.declHome.get(`${file}::${want}`);
    if (home !== undefined) out.add(`${home}::${want}`);
    for (const f of graph.forwards) {
      if (f.file === file && f.exported === want) {
        out.add(`${file}::${want}`);
        // A namespace re-export (`export * as ns`) carries source "*" and
        // passes the wanted name through to its target.
        stack.push([f.target, f.source === "*" ? want : f.source]);
      }
    }
    for (const s of graph.stars) {
      if (s.file === file) {
        out.add(`${file}::${want}`);
        stack.push([s.target, want]);
      }
    }
  }
  return out;
}

// AST walk: every static export and import shape the compiler accepts is
// understood, so an unfamiliar shape can never green-light rot or red-light
// an unrelated PR. Namespace imports, bare export-star re-exports, and
// dynamic import()/require() act as wildcards.
function collectFile(
  rel: string,
  source: ts.SourceFile,
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
        // export * as ns from "…" — a named surface entry, checked like an
        // explicit forward below; the "*" source passes the wanted name
        // through in homes(). Bare export * stays a wildcard star.
        if (spec != null && ts.isStringLiteral(spec))
          forwards.push({ exported: clause.name.text, source: "*", spec: spec.text });
        continue;
      }
      for (const el of clause.elements) {
        const exported = el.name.text;
        const sourceName = (el.propertyName ?? el.name).text;
        if (spec != null && ts.isStringLiteral(spec)) {
          forwards.push({ exported, source: sourceName, spec: spec.text });
        } else {
          decls.push({ name: exported, home: rel });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      decls.push({ name: "default", home: rel });
      continue;
    }
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
  // Dynamic consumers live at arbitrary nesting depth, so they need a full
  // subtree walk rather than the top-level statement scan above. A dynamic
  // specifier resolves to a module, not a name, hence the wildcard.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ name: "*", spec: arg.text });
        } else if (ts.isIdentifier(callee) && callee.text === "require") {
          imports.push({ name: "*", spec: arg.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function collectDead(): { dead: string[]; total: number } {
  const files = trackedTsFiles();
  const tracked = new Set(files);
  const pkgs = packageTable();
  const dirs = scopedDirs(pkgs, tracked);
  const inScope = (f: string): boolean =>
    !f.endsWith(".test.ts") && dirs.some((d) => f === d || f.startsWith(`${d}/`));

  const graph: Graph = { declHome: new Map(), decls: [], forwards: [], stars: [] };
  const imports: ImportSite[] = [];
  // The graph spans every tracked file so re-export chains through
  // out-of-scope surfaces (notably @sprout/server/api-type) resolve;
  // only scoped homes are reported dead below.
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      throw new Error(`dead-exports guard: tracked file missing from working tree: ${rel}`);
    }
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const decls: Decl[] = [];
    const fileImports: { name: string; spec: string }[] = [];
    const fileForwards: { exported: string; source: string; spec: string }[] = [];
    const fileStars: string[] = [];
    collectFile(rel, source, decls, fileImports, fileForwards, fileStars);
    for (const s of fileImports) {
      imports.push({ file: rel, name: s.name, target: resolveSpec(s.spec, rel, tracked, pkgs) });
    }
    for (const d of decls) graph.declHome.set(`${rel}::${d.name}`, rel);
    graph.decls.push(...decls);
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
  }
  // One resolution per forward: the scoped sets filter the graph instead of
  // re-resolving specifiers into string-encoded duplicates.
  const scopedDecls = graph.decls.filter((d) => inScope(d.home));
  const scopedForwards = graph.forwards.filter((f) => inScope(f.file));

  const dead: string[] = [];
  const seed = (s: ImportSite, want: string): string => (s.name === "*" ? want : s.name);
  const importerOf = (name: string, home: string): boolean =>
    imports.some(
      (s) => s.file !== home && homes(graph, s.target, seed(s, name)).has(`${home}::${name}`),
    );
  for (const d of scopedDecls) {
    if (!importerOf(d.name, d.home))
      dead.push(`${d.home}: ${d.name} has no importer outside its home module`);
  }
  const total = scopedDecls.length + scopedForwards.length;
  for (const f of scopedForwards) {
    if (
      !imports.some(
        (s) =>
          s.file !== f.file &&
          homes(graph, s.target, seed(s, f.exported)).has(`${f.file}::${f.exported}`),
      )
    ) {
      dead.push(`${f.file}: re-export '${f.exported}' has no importer`);
    }
  }
  return { dead: dead.sort(), total };
}

describe("dead exports", () => {
  test("every export in the library packages has an importer outside its home module", () => {
    expect(collectDead().dead).toEqual([]);
  });

  test("guard understands every export shape in scope", () => {
    // Reaching here with a non-empty export set proves the scan above
    // actually inspected exports.
    expect(collectDead().total).toBeGreaterThan(0);
  });
});
