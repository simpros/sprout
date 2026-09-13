import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { deployOutcome } from "./deploy-outcome.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "sprout-cli-deploy-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  return dir;
}

function deps(
  overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv },
): CliDeps {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    readTextFile: overrides.readTextFile ?? (async () => null),
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

const HEALTH_YAML = `
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`;

const SNAPSHOT_BASE = {
  ok: true,
  canonical_repo_id: "https://github.com/org/repo",
  pr_id: 42,
  slug: "myapp",
  db_name: "sprout_myapp_pr42",
  hostname: "pr-42.myapp.preview.example.com",
};

describe("deployOutcome", () => {
  test("treats last_error as terminal even when status is running", () => {
    expect(
      deployOutcome({
        status: "running",
        preview_url: "https://example.com",
        last_error: "preview_app_pull_failed",
        last_error_detail: "blip",
      }),
    ).toEqual({
      kind: "failed",
      message: "preview_app_pull_failed: blip",
    });
  });

  test("treats bare failed as terminal", () => {
    expect(deployOutcome({ status: "failed" })).toEqual({
      kind: "failed",
      message: "preview_failed",
    });
  });

  test("seeding without error is pending (seed-resume accept)", () => {
    expect(deployOutcome({ status: "seeding" })).toEqual({ kind: "pending" });
  });

  test("running with preview_url and no error is ready", () => {
    expect(
      deployOutcome({
        status: "running",
        preview_url: "https://pr-42.example.com",
      }),
    ).toEqual({ kind: "ready", previewUrl: "https://pr-42.example.com" });
  });
});

describe("sprout deploy async poll", () => {
  test("polls GET /v1/preview after 202 starting until running", async () => {
    let polls = 0;
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body:
          req.method === "POST"
            ? await req.json()
            : Object.fromEntries(url.searchParams),
        authorization: req.headers.get("authorization"),
      });
      if (url.pathname === "/v1/deploy") {
        return Response.json(
          { ...SNAPSHOT_BASE, status: "starting" },
          { status: 202 },
        );
      }
      polls += 1;
      if (polls < 2) {
        return Response.json({ ...SNAPSHOT_BASE, status: "starting" });
      }
      return Response.json({
        ...SNAPSHOT_BASE,
        status: "running",
        preview_url: "https://pr-42.myapp.preview.example.com",
      });
    });

    let now = 0;
    const cwd = await withWorkspace(HEALTH_YAML);
    const code = await runCli(
      ["deploy", "-i", "ghcr.io/org/app:sha"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/42/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([
      "preview_url=https://pr-42.myapp.preview.example.com",
    ]);
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/deploy",
      "GET /v1/preview",
      "GET /v1/preview",
    ]);
  });

  test("surfaces health_timeout from status poll", async () => {
    let polls = 0;
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        return Response.json(
          { ...SNAPSHOT_BASE, status: "provisioning" },
          { status: 202 },
        );
      }
      polls += 1;
      if (polls === 1) {
        return Response.json({ ...SNAPSHOT_BASE, status: "starting" });
      }
      return Response.json({
        ...SNAPSHOT_BASE,
        status: "failed",
        last_error: "health_timeout",
      });
    });

    let now = 0;
    const cwd = await withWorkspace(HEALTH_YAML);
    const code = await runCli(
      ["deploy", "-i", "ghcr.io/org/app:sha"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/42/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["health_timeout"]);
  });

  test("does not treat seed-resume 202 seeding as preview_failed", async () => {
    let polls = 0;
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/deploy") {
        // Accept after seed_failed: plan is seeding, not terminal failed.
        return Response.json(
          { ...SNAPSHOT_BASE, status: "seeding" },
          { status: 202 },
        );
      }
      polls += 1;
      if (polls < 2) {
        return Response.json({ ...SNAPSHOT_BASE, status: "seeding" });
      }
      return Response.json({
        ...SNAPSHOT_BASE,
        status: "running",
        preview_url: "https://pr-42.myapp.preview.example.com",
      });
    });

    let now = 0;
    const cwd = await withWorkspace(HEALTH_YAML);
    const code = await runCli(
      ["deploy", "-i", "ghcr.io/org/app:sha", "-s", "seed:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/42/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "preview_url=https://pr-42.myapp.preview.example.com",
    ]);
  });

  test("exits preview_failed when poll returns bare failed", async () => {
    const baseUrl = startGateway(async (_req, url) => {
      if (url.pathname === "/v1/deploy") {
        return Response.json(
          { ...SNAPSHOT_BASE, status: "provisioning" },
          { status: 202 },
        );
      }
      return Response.json({ ...SNAPSHOT_BASE, status: "failed" });
    });

    let now = 0;
    const cwd = await withWorkspace(HEALTH_YAML);
    const code = await runCli(
      ["deploy", "-i", "ghcr.io/org/app:sha"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/42/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["preview_failed"]);
  });

  test("deploy forwards --service and yaml service routing", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        status: "running",
        preview_url: "https://pr-9.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: api
      hostname: "api-pr-{pr_id}.example.com"
`);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "--service",
        "api=ghcr.io/org/api:sha",
        "--service",
        "worker=ghcr.io/org/worker:sha",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      services: [
        {
          name: "api",
          image: "ghcr.io/org/api:sha",
          hostname: "api-pr-9.example.com",
        },
        { name: "worker", image: "ghcr.io/org/worker:sha" },
      ],
    });
  });

  test("deploy --clear-services posts empty services list", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        status: "running",
        preview_url: "https://pr-9.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1", "--clear-services"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({ services: [] });
  });

  test("deploy rejects --clear-services with --service", async () => {
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "--clear-services",
        "--service",
        "api=img:1",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: "http://127.0.0.1:9",
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain(
      "--clear-services cannot be combined with --service",
    );
  });

  test("deploy fails stable_per_pr without SPROUT_TOKEN (admin fallback insufficient)", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ ok: true, status: "running", preview_url: "x" });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    BETTER_AUTH_SECRET:
      generate: stable_per_pr
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_ADMIN_TOKEN: "admin-only",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.app_env.BETTER_AUTH_SECRET: SPROUT_TOKEN required for generate: stable_per_pr",
    );
    expect(captured).toEqual([]);
  });
});
