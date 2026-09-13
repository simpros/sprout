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

  test("ci preview builds, pushes, and deploys from MR env", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "sprout-ci-preview-"));
    await Bun.write(
      join(dir, ".sprout.yaml"),
      `slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`,
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          ok: true,
          status: "running",
          preview_url: "https://pr-9.example.com",
        }),
    });
    const dockerCalls: string[][] = [];
    const written: Record<string, string> = {};
    try {
      const code = await runCli(
        ["ci", "preview"],
        deps({
          cwd: dir,
          env: {
            SPROUT_URL: `http://127.0.0.1:${server.port}`,
            SPROUT_TOKEN: "tok",
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_MERGE_REQUEST_IID: "9",
            CI_PIPELINE_SOURCE: "merge_request_event",
            CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
            CI_COMMIT_SHA: "deadbeef",
          },
          readTextFile: async (path) => Bun.file(path).text(),
          runCommand: async (argv) => {
            dockerCalls.push(argv);
            return { exitCode: 0 };
          },
          writeTextFile: async (path, content) => {
            written[path] = content;
          },
        }),
      );
      expect(code).toBe(0);
      expect(stdout).toEqual(["preview_url=https://pr-9.example.com"]);
      expect(dockerCalls).toEqual([
        [
          "docker",
          "build",
          "-f",
          "Dockerfile",
          "-t",
          "registry.gitlab.com/group/repo:deadbeef",
          ".",
        ],
        ["docker", "push", "registry.gitlab.com/group/repo:deadbeef"],
      ]);
      expect(written).toEqual({
        [`${dir}/sprout-preview.env`]: "PREVIEW_URL=https://pr-9.example.com\n",
      });
    } finally {
      server.stop(true);
    }
  });

  test("ci preview with valid MR env but no token fails on auth", async () => {
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
