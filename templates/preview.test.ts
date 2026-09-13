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
  test("declares every required spec:input", () => {
    expect(COMPONENT).toContain("spec:");
    expect(COMPONENT).toContain("inputs:");
    for (const name of REQUIRED_INPUTS) {
      expect(COMPONENT).toContain(`\n    ${name}:`);
    }
  });

  test("sprout_version default is the release sentinel (release job pins it to the tag)", () => {
    expect(COMPONENT).toContain('default: "@SPROUT_COMPONENT_VERSION@"');
  });

  test("spec inputs are exactly the contract set (no dockerfile guards, no extra-args hatch)", () => {
    const specBlock = /spec:\n([\s\S]*?)\n---/.exec(COMPONENT)?.[1] ?? "";
    const names = [...specBlock.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...REQUIRED_INPUTS].sort());
    for (const gone of ["app_dockerfile", "seed_dockerfile", "preview_extra_args"]) {
      expect(COMPONENT).not.toContain(gone);
    }
    expect(COMPONENT).not.toContain("EXTRA_ARGS");
    expect(COMPONENT).not.toContain("SC2086");
  });

  test("deploy job bootstraps then runs sprout ci preview; stop job runs teardown", () => {
    expect(COMPONENT).toContain("sprout ci preview");
    expect(COMPONENT).toContain("sprout ci teardown");
    expect(COMPONENT).toContain("on_stop: sprout-stop-preview");
    expect(COMPONENT).toContain("action: stop");
  });

  test("dotenv artifact feeds environment:url; auto_stop_in is an input", () => {
    expect(COMPONENT).toContain("dotenv:");
    expect(COMPONENT).toContain("url: $PREVIEW_URL");
    expect(COMPONENT).toContain("auto_stop_in: $[[ inputs.auto_stop_in ]]");
  });

  test("dind service, registry login, and apk prerequisites live inside the component", () => {
    expect(COMPONENT).toContain("docker:24-dind");
    expect(COMPONENT).toContain("docker login");
    expect(COMPONENT).toContain("apk add");
    expect(COMPONENT).toContain("libstdc++");
  });

  test("binary install is pinned and checksum-verified", () => {
    expect(COMPONENT).toContain("sprout-linux-x64-musl");
    expect(COMPONENT).toContain("SHA256SUMS.txt");
    expect(COMPONENT).toContain("sha256sum -c");
    expect(COMPONENT).toContain('test "$(sprout --version)" = "$SPROUT_VERSION"');
  });

  test("self-contained: no spec:include, no global keywords", () => {
    expect(COMPONENT).not.toContain("spec:include");
    expect(COMPONENT).not.toMatch(/^default:/m);
    expect(COMPONENT).not.toMatch(/^variables:/m);
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
 * the three embedded shell programs. A hand-rolled indent scraper used to live
 * here; it truncated `before_script` at the first column-0 comment and
 * green-checked a file GitLab could not parse, so structure now comes from a
 * real YAML parse — if the file stops parsing, every test below fails.
 */
function jobScripts(): { base: string[]; preview: string[]; stop: string[] } {
  const docs = Bun.YAML.parse(COMPONENT, { multiDocument: true }) as Array<
    Record<string, { before_script?: string[]; script?: string[] }>
  >;
  const jobs = docs.find((d) => ".sprout-preview-base" in d);
  if (!jobs) throw new Error("jobs document missing from preview.yml");
  return {
    base: jobs[".sprout-preview-base"].before_script ?? [],
    preview: jobs["sprout-preview"].script ?? [],
    stop: jobs["sprout-stop-preview"].script ?? [],
  };
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
    const { base, preview, stop } = jobScripts();
    // .sprout-preview-base before_script + preview script + stop script.
    expect(base.length).toBe(1);
    expect(preview.length).toBe(1);
    expect(stop.length).toBe(1);
  });

  test("before_script carries the full install/checksum sequence", () => {
    const { base } = jobScripts();
    // Regression: a column-0 comment once ended the `|` block scalar early,
    // silently dropping everything below from the job while the raw text
    // still contained it. Assert on the PARSED block, not the raw file.
    for (const needle of [
      "INSTALL_TMP",
      "SHA256SUMS.txt",
      "sha256sum -c",
      'test "$(sprout --version)" = "$SPROUT_VERSION"',
    ]) {
      expect(base[0]).toContain(needle);
    }
  });

  test("every embedded script passes sh -n after input interpolation", async () => {
    const { base, preview, stop } = jobScripts();
    const scripts = [...base, ...preview, ...stop];
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
