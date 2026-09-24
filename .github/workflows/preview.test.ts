import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const WORKFLOW = await Bun.file(join(DIR, "preview.yml")).text();
const CALLER = await Bun.file(
  join(DIR, "../../examples/adopting-repo/.github/workflows/sprout.yml"),
).text();

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string | boolean;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  "working-directory"?: string;
};

type WorkflowJob = {
  needs?: string | string[];
  if?: string | boolean;
  outputs?: Record<string, string>;
  environment?: { name?: string; url?: string };
  steps?: WorkflowStep[];
};

type WorkflowCallIo = {
  required?: boolean;
  default?: string;
};

type WorkflowDoc = {
  on: {
    workflow_call: {
      inputs: Record<string, WorkflowCallIo>;
      secrets: Record<string, WorkflowCallIo>;
      outputs: Record<string, { value?: string }>;
    };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, WorkflowJob>;
};

const DOC: WorkflowDoc = Bun.YAML.parse(WORKFLOW) as WorkflowDoc;

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

function stepsOf(job: string): WorkflowStep[] {
  const found = DOC.jobs[job]?.steps;
  if (!found) throw new Error(`workflow job missing: ${job}`);
  return found;
}

function allSteps(): WorkflowStep[] {
  return Object.values(DOC.jobs).flatMap((job) => job.steps ?? []);
}

function stepByName(job: string, name: string): WorkflowStep {
  const found = stepsOf(job).find((s) => s.name === name);
  if (!found) throw new Error(`workflow step missing: ${job}/${name}`);
  return found;
}

function stepById(job: string, id: string): WorkflowStep {
  const found = stepsOf(job).find((s) => s.id === id);
  if (!found) throw new Error(`workflow step id missing: ${job}/${id}`);
  return found;
}

describe("reusable preview workflow contract", () => {
  test("triggers only on workflow_call", () => {
    expect(Object.keys(DOC.on)).toEqual(["workflow_call"]);
  });

  test("inputs are exactly the contract set", () => {
    expect(Object.keys(DOC.on.workflow_call.inputs).sort()).toEqual(
      [...REQUIRED_INPUTS].sort(),
    );
  });

  test("secrets are exactly the contract set; URL/token required", () => {
    const secrets = DOC.on.workflow_call.secrets;
    expect(Object.keys(secrets).sort()).toEqual([...REQUIRED_SECRETS].sort());
    expect(secrets.SPROUT_URL?.required).toBe(true);
    expect(secrets.SPROUT_TOKEN?.required).toBe(true);
    expect(secrets.SPROUT_APP_ENV?.required).toBe(false);
    expect(secrets.SPROUT_SEED_ENV?.required).toBe(false);
  });

  test("sprout_version is required and never derived from the workflow ref", () => {
    const input = DOC.on.workflow_call.inputs.sprout_version;
    expect(input?.required).toBe(true);
    expect(input?.default).toBeUndefined();
    expect(WORKFLOW).not.toContain("github.workflow_ref");
    expect(WORKFLOW).not.toContain("refs/tags/");
    expect(WORKFLOW).not.toContain("Resolve sprout version");
    expect(DOC.jobs.setup?.outputs?.version).toBeUndefined();
    const install = stepByName("preview", "Install sprout");
    expect(String(install.env?.SPROUT_VERSION)).toContain(
      "inputs.sprout_version",
    );
    expect(install.run ?? "").toContain("sprout_version input is empty");
  });

  test("exposes preview_url output from the deploy step", () => {
    expect(DOC.on.workflow_call.outputs.preview_url?.value).toContain(
      "jobs.preview.outputs.preview_url",
    );
    expect(DOC.jobs.preview?.outputs?.preview_url).toContain(
      "steps.deploy.outputs.preview_url",
    );
  });

  test("concurrency is per-PR and serial", () => {
    expect(String(DOC.concurrency.group)).toContain(
      "github.event.pull_request.number",
    );
    expect(DOC.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("environment url reads the deploy step output", () => {
    expect(DOC.jobs.preview?.environment?.url).toContain(
      "steps.deploy.outputs.preview_url",
    );
  });

  test("install uses the glibc asset verified against SHA256SUMS.txt", () => {
    const install = stepByName("preview", "Install sprout").run ?? "";
    expect(install).toContain("ASSET=sprout-linux-x64");
    expect(install).not.toContain("musl");
    expect(install).toContain("SHA256SUMS.txt");
    expect(install).toContain("sha256sum -c");
    expect(install).toContain('test "$("$RUNNER_TEMP/bin/sprout" --version)" = "$SPROUT_VERSION"');
  });

  test("single setup gate: edited without reset skips the preview job before checkout", () => {
    const setup = DOC.jobs.setup;
    expect(setup?.outputs?.run_heavy).toContain("steps.gate.outputs.run_heavy");
    expect(DOC.jobs.preview?.needs).toContain("setup");
    expect(String(DOC.jobs.preview?.if)).toBe(
      "needs.setup.outputs.run_heavy == 'true'",
    );
    const check = stepById("setup", "reset_check");
    expect(check.if).toBe("github.event.action == 'edited'");
    expect(check.run).toContain("reset_requested");
    const gate = stepById("setup", "gate").run ?? "";
    expect(gate).toContain("run_heavy=");
    for (const step of stepsOf("preview")) {
      expect(String(step.if ?? "")).not.toContain("reset_requested");
    }
    expect(allSteps().some((s) => s.name === "Skip title-only edit")).toBe(
      false,
    );
  });

  test("skip path never downloads: install lives in the gated preview job", () => {
    for (const step of stepsOf("setup")) {
      expect(step.run ?? "").not.toContain("curl");
    }
    expect(stepsOf("setup").some((s) => s.name === "Install sprout")).toBe(
      false,
    );
    expect(stepsOf("preview").some((s) => s.name === "Install sprout")).toBe(
      true,
    );
  });

  test("reset pre-filter defers to the CLI contract (no re-implemented parser)", () => {
    const check = stepById("setup", "reset_check").run ?? "";
    expect(check).toContain("sprout-reset");
    expect(check).toContain("reset_requested=");
    expect(check).toContain("classifyResetRequest");
    for (const gone of ["python3", "in_fence", "finditer", "len(token)", "256"]) {
      expect(check).not.toContain(gone);
    }
  });

  test("deploy runs sprout ci preview; closed runs teardown; no hand-rolled shape", () => {
    const deploy = stepByName("preview", "Deploy preview");
    expect(deploy.run).toContain("sprout ci preview");
    expect(deploy.if).toBe("github.event.action != 'closed'");
    const teardown = stepByName("preview", "Teardown preview");
    expect(teardown.run).toContain("sprout ci teardown");
    expect(teardown.if).toBe("github.event.action == 'closed'");
    for (const gone of ["sprout deploy -i", "docker build -t", "github-script"]) {
      for (const step of allSteps()) {
        if (typeof step.run === "string") expect(step.run).not.toContain(gone);
      }
      if (gone === "github-script") expect(WORKFLOW).not.toContain(gone);
    }
  });

  test("registry login falls back to the GitHub token; image defaults to the caller repo", () => {
    const login = stepByName("preview", "Log in to container registry");
    expect(String(login.with?.registry)).toContain("inputs.registry");
    expect(String(login.with?.username)).toContain("github.actor");
    expect(String(login.with?.password)).toContain("github.token");
    const prep = stepByName("preview", "Prepare image ref and env blobs").run ?? "";
    expect(prep).toContain("CI_REGISTRY_IMAGE=");
    expect(prep).toContain("github.repository");
    expect(prep).toContain("SPROUT_APP_ENV=$RUNNER_TEMP/sprout-app.env");
    expect(prep).toContain("SPROUT_SEED_ENV=$RUNNER_TEMP/sprout-seed.env");
  });

  test("deploy and teardown run in app_context with repo-root-relative dotenv paths", () => {
    const deploy = stepByName("preview", "Deploy preview");
    expect(deploy["working-directory"]).toContain("inputs.app_context");
    const run = deploy.run ?? "";
    expect(run).toContain("$GITHUB_WORKSPACE/${{ inputs.dotenv_file }}");
    expect(run).toContain("$GITHUB_WORKSPACE/${{ inputs.app_env_file }}");
    expect(run).toContain("$GITHUB_WORKSPACE/${{ inputs.seed_env_file }}");
    expect(run).toContain("--app-env-file");
    expect(run).toContain("--seed-env-file");
    expect(run).not.toContain("abs()");
    expect(run).not.toMatch(/^\s*cd /m);
    const teardown = stepByName("preview", "Teardown preview");
    expect(teardown["working-directory"]).toContain("inputs.app_context");
    expect(teardown.run ?? "").not.toMatch(/^\s*cd /m);
  });
});

describe("example caller workflow", () => {
  test("caller is triggers plus one uses: line (no install, build, or commenter)", () => {
    const doc = Bun.YAML.parse(CALLER) as {
      on: { pull_request: { types: string[] } };
      permissions: Record<string, string>;
      jobs: Record<string, { uses?: string; with?: Record<string, string> }>;
    };
    expect(doc.on.pull_request.types.sort()).toEqual(
      ["closed", "edited", "opened", "reopened", "synchronize"].sort(),
    );
    expect(doc.permissions["pull-requests"]).toBe("write");
    const jobs = Object.values(doc.jobs);
    expect(jobs).toHaveLength(1);
    expect(String(jobs[0]!.uses)).toMatch(
      /^simpros\/sprout\/\.github\/workflows\/preview\.yml@v/,
    );
    expect(String(jobs[0]!.with?.sprout_version)).toMatch(/^v/);
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

function maskExpressions(script: string): string {
  return script.replace(/\$\{\{\s*[^}]+\s*\}\}/g, "EXPR");
}

describe("reusable workflow shell syntax", () => {
  test("every run: script passes sh -n with expressions masked", async () => {
    for (const step of allSteps()) {
      if (typeof step.run !== "string") continue;
      const label = String(step.id ?? step.name ?? "unknown").replaceAll("/", "_");
      const path = join(tmpdir(), `sprout-gh-preview-${label}.sh`);
      await Bun.write(path, maskExpressions(step.run));
      const proc = Bun.spawnSync(["sh", "-n", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = proc.stderr.toString().trim();
      expect(`${path}: ${stderr}`).toBe(`${path}: `);
      expect(proc.exitCode).toBe(0);
    }
  });

  test("every expression in run: scripts is double-quoted", () => {
    const unquoted: string[] = [];
    for (const step of allSteps()) {
      if (typeof step.run !== "string") continue;
      for (const line of step.run.split("\n")) {
        let index = line.indexOf("${{");
        while (index !== -1) {
          const quotes = line.slice(0, index).split('"').length - 1;
          if (quotes % 2 === 0) {
            unquoted.push(`${step.id ?? step.name}: ${line.trim()}`);
          }
          index = line.indexOf("${{", index + 1);
        }
      }
    }
    expect(unquoted).toEqual([]);
  });
});
