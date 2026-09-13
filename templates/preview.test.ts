import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const COMPONENT = await Bun.file(join(DIR, "preview.yml")).text();
const README = await Bun.file(join(DIR, "README.md")).text();

/** Every `spec:inputs` entry the component contract requires (#127). */
const REQUIRED_INPUTS = [
  "sprout_version",
  "stage",
  "sprout_url",
  "app_context",
  "auto_stop_in",
  "app_env_file",
  "seed_env_file",
  "dotenv_file",
  "tail",
] as const;

describe("preview component contract", () => {
  test("spec inputs are exactly the contract set (no dockerfile guards, no extra-args hatch)", () => {
    const { spec } = componentDocs();
    expect(Object.keys(spec.inputs).sort()).toEqual([...REQUIRED_INPUTS].sort());
    for (const gone of ["app_dockerfile", "seed_dockerfile", "preview_extra_args"]) {
      expect(COMPONENT).not.toContain(gone);
    }
    expect(COMPONENT).not.toContain("EXTRA_ARGS");
    expect(COMPONENT).not.toContain("SC2086");
  });

  test("sprout_version default is the release sentinel (release job pins it to the tag)", () => {
    const { spec } = componentDocs();
    expect(spec.inputs.sprout_version.default).toBe("@SPROUT_COMPONENT_VERSION@");
  });

  test("job graph: preview gets dind via the shared base, stop is install-only", () => {
    const { jobs } = componentDocs();
    expect(jobs[".sprout-preview-base"].extends).toBe(".sprout-cli");
    expect(jobs["sprout-preview"].extends).toBe(".sprout-preview-base");
    expect(jobs["sprout-stop-preview"].extends).toBe(".sprout-cli");
    // dind lives only on the preview path: teardown never starts a daemon.
    expect(JSON.stringify(jobs[".sprout-preview-base"].services)).toContain(
      "docker:24-dind",
    );
    expect(jobs[".sprout-cli"]).not.toHaveProperty("services");
    expect(jobs["sprout-stop-preview"]).not.toHaveProperty("services");
    // Only the preview path logs in: teardown pushes no images.
    const cliBase = cliBeforeScript();
    expect(cliBase).not.toContain("docker login");
    expect(stopScript()).not.toContain("docker login");
    expect(previewScript()).toContain("docker login");
  });

  test("deploy job runs sprout ci preview; stop job runs teardown", () => {
    const { jobs } = componentDocs();
    expect(previewScript()).toContain("sprout ci preview");
    expect(stopScript()).toContain("sprout ci teardown");
    expect(jobs["sprout-preview"].environment.on_stop).toBe("sprout-stop-preview");
    expect(jobs["sprout-stop-preview"].environment.action).toBe("stop");
  });

  test("dotenv artifact feeds environment:url; auto_stop_in is an input", () => {
    const { jobs } = componentDocs();
    expect(jobs["sprout-preview"].artifacts.reports.dotenv).toBe(
      "$[[ inputs.dotenv_file ]]",
    );
    expect(jobs["sprout-preview"].environment.url).toBe("$PREVIEW_URL");
    expect(jobs["sprout-preview"].environment.auto_stop_in).toBe(
      "$[[ inputs.auto_stop_in ]]",
    );
  });

  test("dind service and apk prerequisites live inside the component", () => {
    const { jobs } = componentDocs();
    expect(JSON.stringify(jobs[".sprout-preview-base"].services)).toContain(
      "docker:24-dind",
    );
    const base = cliBeforeScript();
    expect(base).toContain("apk add");
    expect(base).toContain("libstdc++");
  });

  test("binary install is pinned and checksum-verified", () => {
    const base = cliBeforeScript();
    expect(base).toContain("sprout-linux-x64-musl");
    expect(base).toContain("SHA256SUMS.txt");
    expect(base).toContain("sha256sum -c");
    expect(base).toContain('test "$(sprout --version)" = "$SPROUT_VERSION"');
  });

  test("self-contained: no spec:include, no global keywords", () => {
    const { jobs } = componentDocs();
    expect(COMPONENT).not.toContain("spec:include");
    expect(jobs).not.toHaveProperty("default");
    expect(jobs).not.toHaveProperty("variables");
  });

  test("README documents every input plus the remote fallback", () => {
    for (const name of REQUIRED_INPUTS) {
      expect(README).toContain(name);
    }
    expect(README).toContain("remote:");
    expect(README).toContain("raw.githubusercontent.com/simpros/sprout");
  });
});

/**
 * Parse `preview.yml` as multi-document YAML (spec doc + jobs doc) and return
 * the spec plus the job mapping. A hand-rolled indent scraper used to live
 * here; it truncated `before_script` at the first column-0 comment and
 * green-checked a file GitLab could not parse, so every guarantee above
 * comes from a real YAML parse — if the file stops parsing, the contract
 * fails with it. Raw-text checks survive only for the sentinel string and
 * for asserting removed inputs stay removed.
 */
function componentDocs(): {
  spec: { inputs: Record<string, { default?: unknown }> };
  jobs: Record<string, Record<string, any>>;
} {
  const docs = Bun.YAML.parse(COMPONENT, { multiDocument: true }) as Array<
    Record<string, any>
  >;
  const specDoc = docs.find((d) => d && typeof d === "object" && "spec" in d);
  const jobsDoc = docs.find(
    (d) => d && typeof d === "object" && ".sprout-cli" in d,
  );
  if (!specDoc) throw new Error("spec document missing from preview.yml");
  if (!jobsDoc) throw new Error("jobs document missing from preview.yml");
  return { spec: specDoc.spec, jobs: jobsDoc };
}

function cliBeforeScript(): string {
  const { jobs } = componentDocs();
  const base = jobs[".sprout-cli"].before_script;
  if (!Array.isArray(base) || base.length !== 1 || typeof base[0] !== "string") {
    throw new Error(".sprout-cli must carry exactly one before_script block");
  }
  return base[0];
}

function previewScript(): string {
  const { jobs } = componentDocs();
  const script = jobs["sprout-preview"].script;
  if (!Array.isArray(script) || script.length !== 1 || typeof script[0] !== "string") {
    throw new Error("sprout-preview must carry exactly one script block");
  }
  return script[0];
}

function stopScript(): string {
  const { jobs } = componentDocs();
  const script = jobs["sprout-stop-preview"].script;
  if (!Array.isArray(script) || script.length !== 1 || typeof script[0] !== "string") {
    throw new Error("sprout-stop-preview must carry exactly one script block");
  }
  return script[0];
}

const INPUT_INTERPOLATION_FIXTURES: Record<string, string> = {
  sprout_version: "v0.0.0-test",
  stage: "deploy",
  sprout_url: "",
  app_context: ".",
  auto_stop_in: "1 week",
  app_env_file: "",
  seed_env_file: "",
  dotenv_file: "sprout-preview.env",
  tail: "200",
};

function interpolateInputs(script: string): string {
  return script.replace(
    /\$\[\[\s*inputs\.([a-z_]+)\s*\]\]/g,
    (_, name: string) => INPUT_INTERPOLATION_FIXTURES[name] ?? "",
  );
}

describe("preview component shell syntax", () => {
  test("preview.yml parses as multi-doc YAML with all three scripts", () => {
    const { jobs } = componentDocs();
    // .sprout-cli before_script + preview script + stop script. The
    // preview-only base carries services/extends but no shell of its own —
    // locking that split keeps teardown off the dind path.
    expect(Object.keys(jobs).sort()).toEqual(
      [".sprout-cli", ".sprout-preview-base", "sprout-preview", "sprout-stop-preview"].sort(),
    );
    expect(jobs[".sprout-preview-base"]).not.toHaveProperty("before_script");
    expect(jobs[".sprout-preview-base"]).not.toHaveProperty("script");
    cliBeforeScript();
    previewScript();
    stopScript();
  });

  test("before_script carries the full install/checksum sequence", () => {
    const base = cliBeforeScript();
    // Regression: a column-0 comment once ended the `|` block scalar early,
    // silently dropping everything below from the job while the raw text
    // still contained it. Assert on the PARSED block, not the raw file.
    for (const needle of [
      "INSTALL_TMP",
      "SHA256SUMS.txt",
      "sha256sum -c",
      'test "$(sprout --version)" = "$SPROUT_VERSION"',
    ]) {
      expect(base).toContain(needle);
    }
  });

  test("unpinned sentinel fails fast with a pointer (remote includes)", async () => {
    const base = cliBeforeScript();
    const start = base.indexOf('case "$SPROUT_VERSION" in');
    const end = base.indexOf("esac", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const guard = base.slice(start, end + "esac".length);
    expect(guard).toContain("is unpinned");
    for (const [version, ok] of [
      ["@SPROUT_COMPONENT_VERSION@", false],
      ["v0.6.0", true],
    ] as const) {
      const path = join(tmpdir(), `sprout-guard-${ok}.sh`);
      await Bun.write(path, `SPROUT_VERSION=${JSON.stringify(version)}\n${guard}\n`);
      const proc = Bun.spawnSync(["sh", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(ok ? 0 : 1);
      if (!ok) {
        expect(proc.stderr.toString()).toContain("must set sprout_version");
      }
    }
  });

  test("every embedded script passes sh -n after input interpolation", async () => {
    const scripts = [cliBeforeScript(), previewScript(), stopScript()];
    for (const [i, script] of scripts.entries()) {
      const interpolated = interpolateInputs(script);
      expect(interpolated).not.toContain("$[[");
      const path = join(tmpdir(), `sprout-preview-script-${i}.sh`);
      await Bun.write(path, interpolated);
      const proc = Bun.spawnSync(["sh", "-n", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = proc.stderr.toString().trim();
      expect(`${path}: ${stderr}`).toBe(`${path}: `);
      expect(proc.exitCode).toBe(0);
    }
  });
});
