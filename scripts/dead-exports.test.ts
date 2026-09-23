import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The barrel trim recurs whenever an export outlives its last importer, so
// every export here must be referenced outside its home module (barrel,
// consumer, or direct-path test) — no hand-kept lists to rot.
const SCOPED_DIRS = ["packages/preview-env/src", "packages/preview-db/src"];

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

function definitionFiles(): string[] {
  return git(["ls-files", "--", ...SCOPED_DIRS])
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

function exportedNames(rel: string): string[] {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const decl = line.match(
      /^export\s+(?:async\s+)?(?:const|let|var|function|class|interface|enum|type)\s+([A-Za-z0-9_]+)/,
    );
    if (decl) {
      names.push(decl[1]);
      continue;
    }
    if (/^export\s*\{/.test(line)) continue; // barrel re-export, checked at its home module
    if (/^export\s/.test(line)) {
      throw new Error(`${rel}: unsupported export shape: ${line}`);
    }
  }
  return names;
}

function referencingFiles(name: string, home: string): string[] {
  return git(["grep", "-l", "-w", "--", name, "--", "*.ts"])
    .split("\n")
    .filter((f) => f !== "" && f !== home);
}

describe("dead exports", () => {
  test("every export in the preview packages has an importer outside its home module", () => {
    const dead: string[] = [];
    for (const rel of definitionFiles()) {
      for (const name of exportedNames(rel)) {
        if (referencingFiles(name, rel).length === 0) dead.push(`${rel}: ${name}`);
      }
    }
    expect(dead).toEqual([]);
  });

  test("guard understands every export shape in scope", () => {
    // exportedNames throws on unrecognized shapes, so reaching here with a
    // non-empty export set proves the scan above actually inspected exports.
    const total = definitionFiles().flatMap(exportedNames).length;
    expect(total).toBeGreaterThan(0);
  });
});
