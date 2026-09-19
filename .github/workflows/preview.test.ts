import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const WORKFLOW = await Bun.file(join(DIR, "preview.yml")).text();
const CALLER = await Bun.file(
  join(DIR, "../../examples/adopting-repo/.github/workflows/sprout.yml"),
).text();

const REQUIRED_INPUTS = [
  "sprout_version",
  "app_context",
  "registry",
  "image_name",
  "app_env_file",
  "seed_env_file",
  "dotenv_file",
  "tail",
] as const;

const REQUIRED_SECRETS = [
  "SPROUT_URL",
  "SPROUT_TOKEN",
  "SPROUT_APP_ENV",
  "SPROUT_SEED_ENV",
  "REGISTRY_USER",
  "REGISTRY_PASSWORD",
] as const;

describe("reusable preview workflow contract", () => {
  test("triggers only on workflow_call", () => {
    const doc = workflowDoc();
    expect(Object.keys(doc.on)).toEqual(["workflow_call"]);
  });

  test("inputs are exactly the contract set", () => {
    const doc = workflowDoc();
    expect(Object.keys(doc.on.workflow_call.inputs).sort()).toEqual(
      [...REQUIRED_INPUTS].sort(),
    );
  });

  test("secrets are exactly the contract set; URL/token required", () => {
    const doc = workflowDoc();
    const secrets = doc.on.workflow_call.secrets;
    expect(Object.keys(secrets).sort()).toEqual([...REQUIRED_SECRETS].sort());
    expect(secrets.SPROUT_URL.required).toBe(true);
    expect(secrets.SPROUT_TOKEN.required).toBe(true);
    expect(secrets.SPROUT_APP_ENV.required).toBe(false);
    expect(secrets.SPROUT_SEED_ENV.required).toBe(false);
  });

  test("sprout_version defaults empty and resolves from the workflow ref", () => {
    const doc = workflowDoc();
    expect(doc.on.workflow_call.inputs.sprout_version.default).toBe("");
    const resolve = stepByName("Resolve sprout version").run;
    expect(resolve).toContain("inputs.sprout_version");
    expect(resolve).toContain("github.workflow_ref");
    expect(resolve).toContain("refs/tags/");
  });

  test("exposes preview_url output from the deploy step", () => {
    const doc = workflowDoc();
    expect(doc.on.workflow_call.outputs.preview_url.value).toContain(
      "jobs.preview.outputs.preview_url",
    );
    expect(doc.jobs.preview.outputs.preview_url).toContain(
      "steps.deploy.outputs.preview_url",
    );
  });

  test("concurrency is per-PR and serial", () => {
    const doc = workflowDoc();
    expect(String(doc.concurrency.group)).toContain(
      "github.event.pull_request.number",
    );
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("environment url reads the deploy step output", () => {
    const doc = workflowDoc();
    expect(doc.jobs.preview.environment.url).toContain(
      "steps.deploy.outputs.preview_url",
    );
  });

  test("install uses the glibc asset verified against SHA256SUMS.txt", () => {
    const install = stepByName("Install sprout").run;
    expect(install).toContain("ASSET=sprout-linux-x64");
    expect(install).not.toContain("musl");
    expect(install).toContain("SHA256SUMS.txt");
    expect(install).toContain("sha256sum -c");
    expect(install).toContain('test "$("$RUNNER_TEMP/bin/sprout" --version)" = "$SPROUT_VERSION"');
  });

  test("edited runs gate on a reset check; title edits skip heavy steps", () => {
    const doc = workflowDoc();
    const check = stepById("reset_check");
    expect(check.if).toBe("github.event.action == 'edited'");
    expect(check.run).toContain("reset_requested");
    expect(check.run).toContain("sprout-reset");
    const gate =
      "github.event.action != 'edited' || steps.reset_check.outputs.reset_requested == 'true'";
    for (const name of [
      "Log in to container registry",
      "Prepare image ref and env blobs",
      "Deploy preview",
    ]) {
      expect(stepByName(name).if).toContain(gate);
    }
    const skip = stepByName("Skip title-only edit");
    expect(skip.if).toContain("github.event.action == 'edited'");
    expect(skip.if).toContain("reset_requested");
  });

  test("deploy runs sprout ci preview; closed runs teardown; no hand-rolled shape", () => {
    const deploy = stepByName("Deploy preview");
    expect(deploy.run).toContain("sprout ci preview");
    expect(deploy.if).toContain("github.event.action != 'closed'");
    const teardown = stepByName("Teardown preview");
    expect(teardown.run).toContain("sprout ci teardown");
    expect(teardown.if).toBe("github.event.action == 'closed'");
    for (const gone of ["sprout deploy -i", "docker build -t", "github-script"]) {
      for (const step of steps()) {
        if (typeof step.run === "string") expect(step.run).not.toContain(gone);
      }
      if (gone === "github-script") expect(WORKFLOW).not.toContain(gone);
    }
  });

  test("registry login falls back to the GitHub token; image defaults to the caller repo", () => {
    const login = stepByName("Log in to container registry");
    expect(String(login.with.registry)).toContain("inputs.registry");
    expect(String(login.with.username)).toContain("github.actor");
    expect(String(login.with.password)).toContain("github.token");
    const prep = stepByName("Prepare image ref and env blobs").run;
    expect(prep).toContain("CI_REGISTRY_IMAGE=");
    expect(prep).toContain("github.repository");
    expect(prep).toContain("SPROUT_APP_ENV=$RUNNER_TEMP/sprout-app.env");
    expect(prep).toContain("SPROUT_SEED_ENV=$RUNNER_TEMP/sprout-seed.env");
  });

  test("path inputs resolve repo-root-relative before cd into app_context", () => {
    const deploy = stepByName("Deploy preview").run;
    expect(deploy).toContain("$GITHUB_WORKSPACE/$1");
    expect(deploy).toContain('DOTENV_FILE="$(abs "$DOTENV_FILE")"');
    expect(deploy).toContain('APP_ENV_FILE="$(abs "$APP_ENV_FILE")"');
    expect(deploy).toContain('SEED_ENV_FILE="$(abs "$SEED_ENV_FILE")"');
    expect(deploy.indexOf('DOTENV_FILE="$(abs')).toBeLessThan(
      deploy.indexOf('\ncd "$APP_CONTEXT"'),
    );
    expect(deploy).toContain("--app-env-file");
    expect(deploy).toContain("--seed-env-file");
  });
});

describe("example caller workflow", () => {
  test("caller is triggers plus one uses: line (no install, build, or commenter)", () => {
    const doc = Bun.YAML.parse(CALLER) as Record<string, any>;
    expect(doc.on.pull_request.types.sort()).toEqual(
      ["closed", "edited", "opened", "reopened", "synchronize"].sort(),
    );
    expect(doc.permissions["pull-requests"]).toBe("write");
    const jobs = Object.values(doc.jobs) as Array<Record<string, any>>;
    expect(jobs).toHaveLength(1);
    expect(String(jobs[0]!.uses)).toMatch(
      /^simpros\/sprout\/\.github\/workflows\/preview\.yml@v/,
    );
    for (const gone of [
      "curl",
      "docker build",
      "github-script",
      "SPROUT_CLI_TAG",
      "SPROUT_SHA",
      "preview_url=",
    ]) {
      expect(CALLER).not.toContain(gone);
    }
  });
});

function workflowDoc(): Record<string, any> {
  return Bun.YAML.parse(WORKFLOW) as Record<string, any>;
}

function steps(): Array<Record<string, any>> {
  return workflowDoc().jobs.preview.steps as Array<Record<string, any>>;
}

function stepByName(name: string): Record<string, any> {
  const found = steps().find((s) => s.name === name);
  if (!found) throw new Error(`workflow step missing: ${name}`);
  return found;
}

function stepById(id: string): Record<string, any> {
  const found = steps().find((s) => s.id === id);
  if (!found) throw new Error(`workflow step id missing: ${id}`);
  return found;
}

function interpolateExpressions(script: string): string {
  return script
    .replace(/\$\{\{\s*[^}]+\s*\}\}/g, "PLACEHOLDER")
    .replace(/\$RUNNER_TEMP/g, "/tmp/runner")
    .replace(/\$GITHUB_OUTPUT/g, "/tmp/output")
    .replace(/\$GITHUB_PATH/g, "/tmp/path")
    .replace(/\$GITHUB_ENV/g, "/tmp/env")
    .replace(/\$GITHUB_WORKSPACE/g, "/tmp/workspace");
}

describe("reusable workflow shell syntax", () => {
  test("every run: script passes sh -n after expression interpolation", async () => {
    for (const step of steps()) {
      if (typeof step.run !== "string") continue;
      const label = String(step.id ?? step.name ?? "unknown").replaceAll("/", "_");
      const path = join(tmpdir(), `sprout-gh-preview-${label}.sh`);
      await Bun.write(path, interpolateExpressions(step.run));
      const proc = Bun.spawnSync(["sh", "-n", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = proc.stderr.toString().trim();
      expect(`${path}: ${stderr}`).toBe(`${path}: `);
      expect(proc.exitCode).toBe(0);
    }
  });

  test("reset check parses the body contract (ticked box plus marker, fences ignored)", async () => {
    const check = stepById("reset_check").run as string;
    const script = check.replace("PR_BODY", "SPROUT_TEST_BODY");
    const cases: Array<[string, string]> = [
      ["- [x] Sprout: reset preview <!-- sprout-reset: ada-1 -->\n", "true"],
      ["- [ ] Sprout: reset preview <!-- sprout-reset: ada-1 -->\n", "false"],
      ["- [x] Sprout: reset preview\n", "false"],
      ["```\n- [x] Sprout: reset preview <!-- sprout-reset: ada-1 -->\n```\n", "false"],
      ["* [X] Sprout: reset preview <!-- sprout-reset: tok-2 -->\n", "true"],
    ];
    for (const [body, want] of cases) {
      const path = join(tmpdir(), "sprout-gh-reset-check.sh");
      await Bun.write(
        path,
        `export SPROUT_TEST_BODY=${JSON.stringify(body)}\nexport GITHUB_OUTPUT="$1"\n${script}\n`,
      );
      const out = join(tmpdir(), "sprout-gh-reset-out.txt");
      await Bun.write(out, "");
      const proc = Bun.spawnSync(["sh", path, out], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GITHUB_OUTPUT: out },
      });
      expect(proc.exitCode).toBe(0);
      const text = await Bun.file(out).text();
      expect(`${JSON.stringify(body)} -> ${text}`).toContain(
        `reset_requested=${want}`,
      );
    }
  });
});
