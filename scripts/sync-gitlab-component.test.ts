import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, cpSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "sync-gitlab-component.sh",
);
const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

function runScript(env: Record<string, string | undefined>) {
  return Bun.spawnSync(["bash", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

function git(dir: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@local",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim();
}

function showFile(gitDir: string, rev: string, path: string) {
  const proc = Bun.spawnSync(["git", "--git-dir", gitDir, "show", `${rev}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git show ${rev}:${path} failed`);
  }
  return proc.stdout.toString();
}

function revParse(gitDir: string, rev: string): string {
  const proc = Bun.spawnSync(["git", "--git-dir", gitDir, "rev-parse", rev], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git rev-parse ${rev} failed`);
  }
  return proc.stdout.toString().trim();
}

function hasFile(gitDir: string, rev: string, path: string): boolean {
  const proc = Bun.spawnSync(
    ["git", "--git-dir", gitDir, "cat-file", "-e", `${rev}:${path}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  return proc.exitCode === 0;
}

function initBareRemote(): string {
  const base = mkdtempSync(join(tmpdir(), "sprout-component-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  git(base, ["init", "--bare", "-q", remote]);
  git(base, ["init", "-q", seed]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "-qm", "seed"]);
  git(seed, ["push", "-q", remote, "HEAD"]);
  return remote;
}

function makeSrcDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sprout-src-"));
  cpSync(join(TEMPLATES_DIR, "preview.yml"), join(dir, "preview.yml"));
  cpSync(join(TEMPLATES_DIR, "README.md"), join(dir, "README.md"));
  return dir;
}

describe("sync-gitlab-component.sh", () => {
  test("skips when the project is unset (forks)", () => {
    const proc = runScript({
      SPROUT_COMPONENT_PROJECT: "",
      VERSION_TAG: "",
      SPROUT_GITLAB_SYNC_TOKEN: "",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("component sync skipped");
  });

  test("fails when the project is set but the token is missing", () => {
    const proc = runScript({
      SPROUT_COMPONENT_PROJECT: "group/sprout-ci",
      VERSION_TAG: "v9.9.9-test",
      SPROUT_GITLAB_SYNC_TOKEN: "",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toMatch(/SPROUT_GITLAB_SYNC_TOKEN/);
  });

  test("fails when the project is set but the tag is missing", () => {
    const proc = runScript({
      SPROUT_COMPONENT_PROJECT: "group/sprout-ci",
      VERSION_TAG: "",
      SPROUT_GITLAB_SYNC_TOKEN: "dummy",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toMatch(/VERSION_TAG/);
  });

  test("pins the sentinel, clears orphans, pushes, and refuses to leave a stale tag", () => {
    const remote = initBareRemote();
    const src = makeSrcDir();
    const tag = "v9.9.9-test";
    // file:// preserves --depth; plain local paths make git ignore it.
    const baseEnv = {
      SPROUT_COMPONENT_PROJECT: "group/sprout-ci",
      VERSION_TAG: tag,
      SPROUT_GITLAB_SYNC_TOKEN: "dummy",
      SPROUT_COMPONENT_GIT_URL: `file://${remote}`,
      SOURCE_TEMPLATES_DIR: src,
    };

    const orphanSeed = mkdtempSync(join(tmpdir(), "sprout-orphan-"));
    git(orphanSeed, ["clone", "-q", remote, "work"]);
    mkdirSync(join(orphanSeed, "work", "templates"), { recursive: true });
    writeFileSync(join(orphanSeed, "work", "templates", "legacy.yml"), "legacy\n");
    git(join(orphanSeed, "work"), ["add", "templates/legacy.yml"]);
    git(join(orphanSeed, "work"), ["commit", "-qm", "orphan"]);
    git(join(orphanSeed, "work"), ["push", "-q", "origin", "HEAD"]);

    const first = runScript(baseEnv);
    expect(`${first.stdout.toString()} ${first.stderr.toString()}`).toContain(
      "component sync ok",
    );
    expect(first.exitCode).toBe(0);
    const published = showFile(remote, tag, "templates/preview.yml");
    expect(published).toContain(`default: "${tag}"`);
    expect(published).not.toContain("@SPROUT_COMPONENT_VERSION@");
    expect(hasFile(remote, tag, "templates/legacy.yml")).toBe(false);

    const second = runScript(baseEnv);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("already points at HEAD");

    appendFileSync(join(src, "preview.yml"), "\n# rebuild probe\n");
    const third = runScript(baseEnv);
    expect(third.exitCode).not.toBe(0);
    expect(third.stderr.toString()).toMatch(/already exists/);
    expect(revParse(remote, "HEAD")).toBe(revParse(remote, tag));
  });

  test("annotated tags pointing at HEAD do not false-fail the stale-tag guard", () => {
    const remote = initBareRemote();
    const src = makeSrcDir();
    const tag = "v9.9.9-annot";
    const baseEnv = {
      SPROUT_COMPONENT_PROJECT: "group/sprout-ci",
      VERSION_TAG: tag,
      SPROUT_GITLAB_SYNC_TOKEN: "dummy",
      SPROUT_COMPONENT_GIT_URL: `file://${remote}`,
      SOURCE_TEMPLATES_DIR: src,
    };

    const first = runScript(baseEnv);
    expect(first.exitCode).toBe(0);
    const pinned = revParse(remote, tag);

    // ls-remote reports the tag object SHA for annotated tags; compare the peeled commit.
    const ctl = mkdtempSync(join(tmpdir(), "sprout-annot-"));
    git(ctl, ["clone", "-q", remote, "work"]);
    const wc = join(ctl, "work");
    git(wc, ["push", "-q", "origin", `:refs/tags/${tag}`]);
    git(wc, ["tag", "-d", tag]);
    git(wc, ["tag", "-a", tag, "-m", tag, pinned]);
    git(wc, ["push", "-q", "origin", tag]);

    const second = runScript(baseEnv);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("already points at HEAD");
  });
});
