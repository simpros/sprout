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
 * Extract `script:` / `before_script:` literal blocks (`- |` items) so both
 * embedded shell programs can be syntax-checked after input interpolation.
 */
function extractScripts(yaml: string): string[] {
  const lines = yaml.split("\n");
  const scripts: string[] = [];
  let collecting = false;
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s+-\s+\|\s*$/.test(line)) {
      collecting = true;
      current = [];
      continue;
    }
    if (collecting) {
      if (line.trim() === "" || /^ {6}\S/.test(line) || /^ {6} /.test(line)) {
        // Block lines are indented 6 spaces; strip that prefix. Blank lines
        // belong to the block.
        current.push(line.startsWith("      ") ? line.slice(6) : line);
        continue;
      }
      collecting = false;
      scripts.push(current.join("\n"));
    }
  }
  if (collecting) scripts.push(current.join("\n"));
  return scripts.filter((s) => s.trim().length > 0);
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
  test("both jobs contribute script blocks", () => {
    const scripts = extractScripts(COMPONENT);
    // .sprout-preview-base before_script + preview script + stop script.
    expect(scripts.length).toBe(3);
  });

  test("every embedded script passes sh -n after input interpolation", async () => {
    const scripts = extractScripts(COMPONENT);
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
