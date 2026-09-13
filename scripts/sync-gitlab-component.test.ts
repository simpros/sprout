import { describe, expect, test } from "bun:test";
import { mkdtempSync, cpSync, appendFileSync, writeFileSync } from "node:fs";
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

/** Seed a bare remote with one commit so `git clone --depth 1` works. */
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

  test("pins the sentinel, pushes, and refuses to leave a stale tag", () => {
    const remote = initBareRemote();
    const src = makeSrcDir();
    const tag = "v9.9.9-test";
    const baseEnv = {
      SPROUT_COMPONENT_PROJECT: "group/sprout-ci",
      VERSION_TAG: tag,
      SPROUT_GITLAB_SYNC_TOKEN: "dummy",
      SPROUT_COMPONENT_GIT_URL: remote,
      SOURCE_TEMPLATES_DIR: src,
    };

    // First sync: pins + tags.
    const first = runScript(baseEnv);
    expect(`${first.stdout.toString()} ${first.stderr.toString()}`).toContain(
      "component sync ok",
    );
    expect(first.exitCode).toBe(0);
    const published = showFile(remote, tag, "templates/preview.yml");
    expect(published).toContain(`default: "${tag}"`);
    expect(published).not.toContain("@SPROUT_COMPONENT_VERSION@");

    // Second sync without changes: tag already points at HEAD, still success.
    const second = runScript(baseEnv);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("already points at HEAD");

    // New content under the same tag: must fail, not leave the tag stale.
    appendFileSync(join(src, "preview.yml"), "\n# rebuild probe\n");
    const third = runScript(baseEnv);
    expect(third.exitCode).not.toBe(0);
    expect(third.stderr.toString()).toMatch(/already exists/);
  });
});
