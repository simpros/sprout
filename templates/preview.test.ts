import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const COMPONENT = await Bun.file(join(DIR, "preview.yml")).text();
const README = await Bun.file(join(DIR, "README.md")).text();

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

  test("job graph: preview carries docker+dind directly, stop/reset are install-only on alpine", () => {
    const { jobs } = componentDocs();
    expect(jobs["sprout-preview"].extends).toBe(".sprout-cli");
    expect(jobs["sprout-stop-preview"].extends).toBe(".sprout-cli");
    expect(jobs["sprout-reset"].extends).toBe(".sprout-cli");
    expect(jobs).not.toHaveProperty(".sprout-preview-base");
    expect(jobs[".sprout-cli"].image).toBe("alpine:3.20");
    expect(jobs["sprout-preview"].image).toBe("docker:24");
    expect(jobs["sprout-preview"].services).toEqual([
      expect.objectContaining({ name: "docker:24-dind" }),
    ]);
    expect(jobs[".sprout-cli"]).not.toHaveProperty("services");
    expect(jobs["sprout-stop-preview"]).not.toHaveProperty("services");
    expect(jobs["sprout-reset"]).not.toHaveProperty("services");
    expect(jobs["sprout-reset"]).not.toHaveProperty("image");
    const cliBase = cliBeforeScript();
    expect(cliBase).not.toContain("docker login");
    expect(stopScript()).not.toContain("docker login");
    expect(resetScript()).not.toContain("docker login");
    expect(previewScript()).toContain("docker login");
  });

  test("stop runs teardown at the project dir with no app_context coupling", () => {
    const stop = stopScript();
    expect(stop).toContain("sprout ci teardown");
    expect(stop).not.toContain("app_context");
  });

  test("all path-shaped inputs resolve project-root-relative, before cd into app_context", () => {
    for (const script of [previewScript(), resetScript()]) {
      expect(script).toContain("$CI_PROJECT_DIR/$1");
      expect(script).toContain('DOTENV_FILE="$(abs "$DOTENV_FILE")"');
      expect(script).toContain('APP_ENV_FILE="$(abs "$APP_ENV_FILE")"');
      expect(script).toContain('SEED_ENV_FILE="$(abs "$SEED_ENV_FILE")"');
      expect(script.indexOf('DOTENV_FILE="$(abs')).toBeLessThan(
        script.indexOf('\ncd "$APP_CONTEXT"'),
      );
      expect(script).toContain("--app-env-file");
      expect(script).toContain("--seed-env-file");
    }
  });

  test("reset shares the deploy prelude with preview so the two cannot drift", () => {
    expect(deployPrelude(resetScript())).toBe(deployPrelude(previewScript()));
    for (const input of [
      "app_context",
      "app_env_file",
      "seed_env_file",
      "dotenv_file",
      "tail",
    ]) {
      expect(resetScript()).toContain(`$[[ inputs.${input} ]]`);
    }
  });

  test("deploy job runs sprout ci preview; stop job runs teardown; reset runs reset", () => {
    const { jobs } = componentDocs();
    expect(previewScript()).toContain("sprout ci preview");
    expect(stopScript()).toContain("sprout ci teardown");
    expect(resetScript()).toContain("sprout ci reset");
    expect(resetScript()).not.toContain("sprout ci preview");
    expect(resetScript()).not.toContain("sprout ci teardown");
    expect(previewScript()).not.toContain("sprout ci reset");
    expect(jobs["sprout-preview"].environment.on_stop).toBe("sprout-stop-preview");
    expect(jobs["sprout-stop-preview"].environment.action).toBe("stop");
    expect(jobs["sprout-reset"]).not.toHaveProperty("environment");
  });

  test("manual stop never blocks pipeline success (#163)", () => {
    const { jobs } = componentDocs();
    const stop = jobs["sprout-stop-preview"];
    expect(stop.when).toBe("manual");
    expect(stop.rules).toEqual([{ if: "$CI_MERGE_REQUEST_IID" }]);
    expect(stop).not.toHaveProperty("allow_failure");
    expect(stop.rules).toEqual(jobs["sprout-preview"].rules);
    expect(jobs["sprout-preview"]).not.toHaveProperty("allow_failure");
  });

  test("manual reset never blocks pipeline success (#163 trap)", () => {
    const { jobs } = componentDocs();
    const reset = jobs["sprout-reset"];
    expect(reset.when).toBe("manual");
    expect(reset.allow_failure).toBe(true);
    expect(reset.rules).toEqual([{ if: "$CI_MERGE_REQUEST_IID" }]);
    expect(reset.rules).toEqual(jobs["sprout-preview"].rules);
    expect(reset.interruptible).toBe(false);
    expect(reset.stage).toBe("$[[ inputs.stage ]]");
  });

  test("reset writes the dotenv artifact with the pipeline CLI version", () => {
    const { jobs } = componentDocs();
    expect(jobs["sprout-reset"].extends).toBe(".sprout-cli");
    expect(jobs["sprout-reset"].artifacts.reports.dotenv).toBe(
      "$[[ inputs.dotenv_file ]]",
    );
    expect(jobs["sprout-reset"].artifacts.reports.dotenv).toBe(
      jobs["sprout-preview"].artifacts.reports.dotenv,
    );
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

function resetScript(): string {
  const { jobs } = componentDocs();
  const script = jobs["sprout-reset"].script;
  if (!Array.isArray(script) || script.length !== 1 || typeof script[0] !== "string") {
    throw new Error("sprout-reset must carry exactly one script block");
  }
  return script[0];
}

function deployPrelude(script: string): string {
  const start = script.indexOf('APP_CONTEXT="$[[ inputs.app_context ]]"');
  if (start < 0) throw new Error("deploy script missing app_context plumbing");
  const invokeAt = script.lastIndexOf("\nsprout ci ");
  if (invokeAt < 0 || invokeAt < start) {
    throw new Error("deploy script missing trailing sprout ci invocation");
  }
  return script.slice(start, invokeAt);
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
  test("preview.yml parses as multi-doc YAML with all four scripts", () => {
    const { jobs } = componentDocs();
    expect(Object.keys(jobs).sort()).toEqual(
      [".sprout-cli", "sprout-preview", "sprout-reset", "sprout-stop-preview"].sort(),
    );
    expect(jobs["sprout-preview"]).toHaveProperty("services");
    cliBeforeScript();
    previewScript();
    resetScript();
    stopScript();
  });

  test("before_script carries the full install/checksum sequence", () => {
    const base = cliBeforeScript();
    // Column-0 comments end YAML block scalars early; assert the parsed block, not raw text.
    for (const needle of [
      "apk add",
      "libstdc++",
      "INSTALL_TMP",
      "sprout-linux-x64-musl",
      "SHA256SUMS.txt",
      "sha256sum -c",
      'test "$(sprout --version)" = "$SPROUT_VERSION"',
    ]) {
      expect(base).toContain(needle);
    }
  });

  test("checksum verifies the downloaded asset via a single ASSET binding", () => {
    const base = cliBeforeScript();
    const assignments = [...base.matchAll(/^ *ASSET=(\S+)/gm)].map((m) => m[1]);
    expect(assignments).toEqual(["sprout-linux-x64-musl"]);
    expect(base).toContain('curl -fsSL -o "$INSTALL_TMP/$ASSET"');
    expect(base).toContain(
      '"https://github.com/simpros/sprout/releases/download/${SPROUT_VERSION}/$ASSET"',
    );
    expect(base).toContain('grep -c " ${ASSET}$"');
    expect(base).toContain('grep " ${ASSET}$" SHA256SUMS.txt | sha256sum -c -');
    expect(base).toContain('install -m 0755 "$INSTALL_TMP/$ASSET"');
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
    const scripts = [
      cliBeforeScript(),
      previewScript(),
      resetScript(),
      stopScript(),
    ];
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
