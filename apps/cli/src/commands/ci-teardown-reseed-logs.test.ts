import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";

type Captured = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let captured: Captured[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  captured = [];
  stdout = [];
  stderr = [];
});

function startGateway(
  handler: (req: Request, url: URL) => Response | Promise<Response>,
) {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      return handler(req, url);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function withWorkspace(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-ci-122-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  return dir;
}

function deps(
  overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv },
): CliDeps {
  return {
    cwd: overrides.cwd ?? "/",
    readTextFile:
      overrides.readTextFile ??
      (async (path) =>
        path.endsWith(".sprout.yaml") ? HEALTH_YAML : null),
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

const HEALTH_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`;

const GITLAB_MR_ENV = {
  CI_PROJECT_URL: "https://gitlab.com/group/repo",
  CI_MERGE_REQUEST_IID: "17",
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
  CI_COMMIT_SHA: "abc123",
};

describe("sprout ci teardown", () => {
  test("tears down from CI env only (Stop-button shape), no flags", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ ok: true, status: "removed" });
    });

    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(captured).toEqual([
      {
        method: "POST",
        path: "/v1/teardown",
        body: {
          canonical_repo_id: "https://gitlab.com/group/repo",
          pr_id: 17,
        },
        authorization: "Bearer t",
      },
    ]);
  });

  test("succeeds when the gateway reports an already-removed preview", async () => {
    const baseUrl = startGateway(async () =>
      Response.json({ ok: true, status: "removed" }),
    );
    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
  });

  test("surfaces the gateway error code on failure", async () => {
    const baseUrl = startGateway(async () =>
      Response.json({ error: "preview_db_drop_failed" }, { status: 500 }),
    );
    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["500 preview_db_drop_failed"]);
  });

  test("refuses detached pipelines before touching the gateway", async () => {
    const baseUrl = startGateway(async () => {
      captured.push({
        method: "GET",
        path: "/unexpected",
        body: null,
        authorization: null,
      });
      return Response.json({ ok: true });
    });
    const code = await runCli(
      ["ci", "teardown"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_PIPELINE_SOURCE: "push",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("detached/non-MR");
    expect(captured).toEqual([]);
  });
});

describe("sprout ci reseed", () => {
  test("re-runs seed with reseed:true, same images, merged app env", async () => {
    let polls = 0;
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy" && req.method === "POST") {
        captured.push({
          method: req.method,
          path: url.pathname,
          body: await req.json(),
          authorization: req.headers.get("authorization"),
        });
        return Response.json({
          ok: true,
          status: "starting",
          preview_url: "https://pr-17.myapp.preview.example.com",
          canonical_repo_id: "https://gitlab.com/group/repo",
          pr_id: 17,
          slug: "myapp",
          db_name: "sprout_myapp_pr17",
          hostname: "pr-17.myapp.preview.example.com",
        });
      }
      polls += 1;
      return Response.json({
        ok: true,
        status: "running",
        preview_url: "https://pr-17.myapp.preview.example.com",
        canonical_repo_id: "https://gitlab.com/group/repo",
        pr_id: 17,
        slug: "myapp",
        db_name: "sprout_myapp_pr17",
        hostname: "pr-17.myapp.preview.example.com",
      });
    });

    const cwd = await withWorkspace(
      `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  app_env:
    SHARED: from-yaml
    KEEP: yaml
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`,
    );
    await Bun.write(
      `${cwd}/preview.app.env`,
      "SHARED=from-file\nFILE_ONLY=1\n",
    );
    const code = await runCli(
      [
        "ci",
        "reseed",
        "-s",
        "registry.gitlab.com/group/repo-seed:abc123",
        "--seed-env",
        "FIXTURE=demo",
        "--app-env-file",
        "preview.app.env",
        "--app-env",
        "SHARED=from-cli",
      ],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
    expect(polls).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: "POST",
      path: "/v1/deploy",
      authorization: "Bearer t",
    });
    expect(captured[0]?.body).toMatchObject({
      canonical_repo_id: "https://gitlab.com/group/repo",
      pr_id: 17,
      slug: "myapp",
      hostname: "pr-17.myapp.preview.example.com",
      // No image rebuild: the already-pushed pipeline tag is reused.
      app_image: "registry.gitlab.com/group/repo:abc123",
      seed_image: "registry.gitlab.com/group/repo-seed:abc123",
      seed_env: ["FIXTURE=demo"],
      reseed: true,
      app_env: ["SHARED=from-cli", "KEEP=yaml", "FILE_ONLY=1"],
    });
    // Companions untouched: no services key means "leave".
    expect(captured[0]?.body).not.toHaveProperty("services");
  });

  test("requires -s <seed-image> before any network call", async () => {
    const baseUrl = startGateway(async () => {
      captured.push({
        method: "GET",
        path: "/unexpected",
        body: null,
        authorization: null,
      });
      return Response.json({ ok: true });
    });
    const code = await runCli(
      ["ci", "reseed"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["ci reseed requires -s <seed-image>"]);
    expect(captured).toEqual([]);
  });

  test("requires the health block for seed runs", async () => {
    const baseUrl = startGateway(async () => Response.json({ ok: true }));
    const cwd = await withWorkspace(`slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    const code = await runCli(
      ["ci", "reseed", "-s", "seed:1"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("health block required");
  });

  test("surfaces gateway deploy errors with the error code", async () => {
    const baseUrl = startGateway(async () =>
      Response.json(
        { error: "seed_image_required_for_reseed" },
        { status: 422 },
      ),
    );
    const code = await runCli(
      ["ci", "reseed", "-s", "seed:1"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["422 seed_image_required_for_reseed"]);
  });

  test("failed seed during polling exits non-zero with the cause", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        return Response.json({
          ok: true,
          status: "starting",
          preview_url: "https://pr-17.myapp.preview.example.com",
        });
      }
      return Response.json({
        ok: true,
        status: "failed",
        last_error: "preview_seed_failed",
        last_error_detail: "exit 3",
        preview_url: "https://pr-17.myapp.preview.example.com",
      });
    });
    const code = await runCli(
      ["ci", "reseed", "-s", "seed:1"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["preview_seed_failed: exit 3"]);
  });

  test("poll timeout exits non-zero", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        return Response.json({ ok: true, status: "starting" });
      }
      return Response.json({ ok: true, status: "starting" });
    });
    let now = 0;
    const code = await runCli(
      ["ci", "reseed", "-s", "seed:1"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["deploy_timeout"]);
  });
});

describe("sprout ci logs", () => {
  const GITHUB_PR_ENV = {
    GITHUB_REPOSITORY: "org/repo",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/42/merge",
  };

  test("prints gateway logs with only CI env present", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: Object.fromEntries(url.searchParams),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        tail: 200,
        app: "hello app\n",
        seed: "hello seed\n",
      });
    });

    const code = await runCli(
      ["ci", "logs"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITHUB_PR_ENV } }),
    );
    expect(code).toBe(0);
    expect(captured).toEqual([
      {
        method: "GET",
        path: "/v1/previews/42/logs",
        body: { canonical_repo_id: "https://github.com/org/repo" },
        authorization: "Bearer t",
      },
    ]);
    expect(stdout).toEqual([
      "=== app ===\nhello app\n=== seed ===\nhello seed",
    ]);
  });

  test("forwards --tail to the gateway", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: Object.fromEntries(url.searchParams),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        tail: 50,
        app: "tail app\n",
        seed: "",
      });
    });

    const code = await runCli(
      ["ci", "logs", "--tail", "50"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITHUB_PR_ENV } }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      canonical_repo_id: "https://github.com/org/repo",
      tail: "50",
    });
    expect(stdout).toEqual(["=== app ===\ntail app"]);
  });

  test("rejects a non-positive --tail before any network call", async () => {
    const baseUrl = startGateway(async () => Response.json({ ok: true }));
    const code = await runCli(
      ["ci", "logs", "--tail", "0"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITHUB_PR_ENV } }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["--tail must be a positive integer"]);
  });

  test("surfaces the gateway error code on failure", async () => {
    const baseUrl = startGateway(async () =>
      Response.json({ error: "preview_not_found" }, { status: 404 }),
    );
    const code = await runCli(
      ["ci", "logs"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITHUB_PR_ENV } }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["404 preview_not_found"]);
  });
});
