import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { resolveSeedImageRef } from "./ci-preview.ts";

type Captured = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let captured: Captured[] = [];
let dockerCalls: string[][] = [];
let dockerBehavior: (argv: string[]) => number = () => 0;
let written: Record<string, string> = {};
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  captured = [];
  dockerCalls = [];
  dockerBehavior = () => 0;
  written = {};
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
  const dir = await mkdtemp(join(tmpdir(), "sprout-ci-preview-"));
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
        path.endsWith(".sprout.yaml") ? MINIMAL_YAML : null),
    getGitRemoteUrl: overrides.getGitRemoteUrl ?? (() => null),
    createClient:
      overrides.createClient ??
      ((baseUrl, token) =>
        createApiClient(baseUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })),
    runCommand:
      overrides.runCommand ??
      (async (argv) => {
        dockerCalls.push(argv);
        return { exitCode: dockerBehavior(argv) };
      }),
    writeTextFile:
      overrides.writeTextFile ??
      (async (path, content) => {
        written[path] = content;
      }),
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    ...overrides,
  };
}

const MINIMAL_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`;

const SEEDED_YAML = `slug: myapp
build:
  dockerfile: Dockerfile
seed:
  dockerfile: Dockerfile.seed
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

const APP_REF = "registry.gitlab.com/group/repo:abc123";
const SEED_REF = "registry.gitlab.com/group/repo-seed:abc123";

function healthyGateway() {
  return startGateway(async (req, url) => {
    if (url.pathname === "/v1/deploy") {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
    }
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
}

describe("resolveSeedImageRef", () => {
  test("suffixes the repo with -seed before the tag", () => {
    expect(resolveSeedImageRef(APP_REF)).toEqual({
      ok: true,
      value: SEED_REF,
    });
  });

  test("handles a registry with a port", () => {
    expect(resolveSeedImageRef("localhost:5000/app:sha")).toEqual({
      ok: true,
      value: "localhost:5000/app-seed:sha",
    });
  });

  test("refuses a ref without a tag", () => {
    expect(resolveSeedImageRef("registry/app").ok).toBe(false);
  });
});

describe("sprout ci preview", () => {
  test("success builds + pushes app and seed, deploys with -s, writes dotenv", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(SEEDED_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(dockerCalls).toEqual([
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
      ["docker", "build", "-f", "Dockerfile.seed", "-t", SEED_REF, "."],
      ["docker", "push", SEED_REF],
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      canonical_repo_id: "https://gitlab.com/group/repo",
      pr_id: 17,
      slug: "myapp",
      hostname: "pr-17.myapp.preview.example.com",
      app_image: APP_REF,
      seed_image: SEED_REF,
    });
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
    expect(written).toEqual({
      [`${cwd}/sprout-preview.env`]:
        "PREVIEW_URL=https://pr-17.myapp.preview.example.com\n",
    });
  });

  test("without a seed block only the app image is built, no -s", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(dockerCalls).toEqual([
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({ app_image: APP_REF });
    expect(captured[0]?.body).not.toHaveProperty("seed_image");
    expect(written[`${cwd}/sprout-preview.env`]).toBe(
      "PREVIEW_URL=https://pr-17.myapp.preview.example.com\n",
    );
  });

  test("seed build failure exits after app push, before deploy", async () => {
    const baseUrl = healthyGateway();
    dockerBehavior = (argv) =>
      argv.includes("Dockerfile.seed") ? 1 : 0;
    const cwd = await withWorkspace(SEEDED_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["seed image build failed (exit 1)"]);
    expect(stdout).toEqual([]);
    expect(dockerCalls).toEqual([
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
      ["docker", "build", "-f", "Dockerfile.seed", "-t", SEED_REF, "."],
    ]);
    expect(captured).toEqual([]);
    expect(written).toEqual({});
  });

  test("app push failure exits before deploy", async () => {
    const baseUrl = healthyGateway();
    dockerBehavior = (argv) => (argv[1] === "push" ? 3 : 0);
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["app image push failed (exit 3)"]);
    expect(stdout).toEqual([]);
    expect(captured).toEqual([]);
    expect(written).toEqual({});
  });

  test("app build failure exits before push or deploy", async () => {
    const baseUrl = healthyGateway();
    dockerBehavior = () => 2;
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["app image build failed (exit 2)"]);
    expect(dockerCalls).toHaveLength(1);
    expect(captured).toEqual([]);
    expect(written).toEqual({});
  });

  test("health timeout dumps gateway logs, exits with the deploy error", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        captured.push({
          method: req.method,
          path: url.pathname,
          body: await req.json(),
          authorization: req.headers.get("authorization"),
        });
        return Response.json({ ok: true, status: "starting" }, { status: 202 });
      }
      if (url.pathname === "/v1/preview") {
        return Response.json({ ok: true, status: "starting" });
      }
      if (url.pathname === "/v1/previews/17/logs") {
        captured.push({
          method: req.method,
          path: url.pathname,
          body: Object.fromEntries(url.searchParams),
          authorization: req.headers.get("authorization"),
        });
        return Response.json({
          ok: true,
          canonical_repo_id: "https://gitlab.com/group/repo",
          pr_id: 17,
          tail: 200,
          app: "migrate: boom\n",
          seed: "",
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    let now = 0;
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["deploy_timeout"]);
    expect(stdout).toEqual(["=== app ===\nmigrate: boom"]);
    expect(written).toEqual({});
    const logsCall = captured.find((c) => c.path === "/v1/previews/17/logs");
    expect(logsCall?.body).toMatchObject({
      canonical_repo_id: "https://gitlab.com/group/repo",
      tail: "200",
    });
  });

  test("failed deploy dumps logs then exits with the deploy error", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        captured.push({
          method: req.method,
          path: url.pathname,
          body: await req.json(),
          authorization: req.headers.get("authorization"),
        });
        return Response.json({ ok: true, status: "starting" }, { status: 202 });
      }
      if (url.pathname === "/v1/preview") {
        return Response.json({
          ok: true,
          status: "failed",
          last_error: "health_timeout",
          preview_url: "https://pr-17.myapp.preview.example.com",
        });
      }
      return Response.json({
        ok: true,
        canonical_repo_id: "https://gitlab.com/group/repo",
        pr_id: 17,
        tail: 50,
        app: "listen: permission denied\n",
        seed: "",
      });
    });
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview", "--tail", "50"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toEqual(["=== app ===\nlisten: permission denied"]);
    expect(stderr).toEqual(["health_timeout"]);
    expect(written).toEqual({});
  });

  test("log dump failure is a warning; the deploy error still exits", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        return Response.json({ ok: true, status: "starting" }, { status: 202 });
      }
      if (url.pathname === "/v1/preview") {
        return Response.json({ ok: true, status: "failed" });
      }
      return Response.json({ error: "preview_not_found" }, { status: 404 });
    });
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "warning: preview log dump failed: 404 preview_not_found",
      "preview_failed",
    ]);
    expect(written).toEqual({});
  });

  test("custom --dotenv-file path is honored", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview", "--dotenv-file", "artifacts/preview.env"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(written).toEqual({
      [`${cwd}/artifacts/preview.env`]:
        "PREVIEW_URL=https://pr-17.myapp.preview.example.com\n",
    });
  });

  test("seed without a health block fails before building", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(`slug: myapp
seed:
  dockerfile: Dockerfile.seed
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("health block required");
    expect(dockerCalls).toEqual([]);
    expect(captured).toEqual([]);
  });

  test("rejects a non-positive --tail before building", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview", "--tail", "0"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["--tail must be a positive integer"]);
    expect(dockerCalls).toEqual([]);
  });

  test("mixed SHA env: {commit_sha} follows the forge SHA, matching the image tag", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(`slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  app_env:
    REF: "{commit_sha}"
`);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_COMMIT_SHA: "aaa",
          GITHUB_SHA: "bbb",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: "registry.gitlab.com/group/repo:aaa",
      app_env: ["REF=aaa"],
    });
  });
});
