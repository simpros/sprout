import { afterEach, describe, expect, test } from "bun:test";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";

let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  stdout = [];
  stderr = [];
});

const MINIMAL_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`;

function deps(
  overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv },
): CliDeps {
  return {
    cwd: overrides.cwd ?? "/",
    readTextFile:
      overrides.readTextFile ??
      (async (path) => (path.endsWith(".sprout.yaml") ? MINIMAL_YAML : null)),
    getGitRemoteUrl: overrides.getGitRemoteUrl ?? (() => null),
    createClient:
      overrides.createClient ??
      ((baseUrl, token) =>
        createApiClient(baseUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })),
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    ...overrides,
  };
}

describe("sprout ci", () => {
  test("ci --help lists subcommands and purpose", async () => {
    const code = await runCli(["ci", "--help"], deps({ env: {} }));
    expect(code).toBe(0);
    const help = stdout.join("\n");
    expect(help).toContain("preview");
    expect(help).toContain("teardown");
    expect(help).toContain("reseed");
    expect(help).toContain("logs");
    expect(stderr).toEqual([]);
  });

  test("ci with no args lists subcommands", async () => {
    const code = await runCli(["ci"], deps({ env: {} }));
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("preview");
  });

  test("ci subcommand outside MR pipeline exits non-zero with actionable message", async () => {
    const code = await runCli(
      ["ci", "preview"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_PIPELINE_SOURCE: "push",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("detached/non-MR");
    expect(stderr[0]).not.toMatch(/at |Error:|stack/i);
  });

  test("ci subcommand without pipeline source exits non-zero", async () => {
    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("merge-request or pull-request");
  });

  test("ci preview with valid MR env reaches not-implemented seam", async () => {
    const code = await runCli(
      ["ci", "preview"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "deadbeef",
          SPROUT_TOKEN: "tok",
          SPROUT_URL: "http://127.0.0.1:9",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("sprout ci preview is not implemented yet");
  });

  test("ci preview with valid MR env but no token fails auth after identity", async () => {
    const code = await runCli(
      ["ci", "preview"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "deadbeef",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required");
  });

  test("ci teardown does not require image ref", async () => {
    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_PIPELINE_SOURCE: "merge_request_event",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required");
  });

  test("ci preview refuses missing image ref", async () => {
    const code = await runCli(
      ["ci", "preview"],
      deps({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_PIPELINE_SOURCE: "merge_request_event",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("cannot derive image ref");
  });
});
