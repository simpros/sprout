import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { SPROUT_NOTE_MARKER } from "./forge-note.ts";

type Captured = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let captured: Captured[] = [];
let dockerCalls: string[][] = [];
let written: Record<string, string> = {};
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  captured = [];
  dockerCalls = [];
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

async function withWorkspace(yaml: string, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sprout-ci-reset-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

async function readRealFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

function deps(
  overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv },
): CliDeps {
  return {
    cwd: overrides.cwd ?? "/",
    readTextFile:
      overrides.readTextFile ?? (async () => MINIMAL_YAML),
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
        return { exitCode: 0 };
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
  GITLAB_USER_LOGIN: "ada",
};

const APP_REF = "registry.gitlab.com/group/repo:abc123";
const COMMIT_SEED_REF = `${APP_REF}-seed`;

function resetGateway(opts?: { deployStatus?: string }) {
  return startGateway(async (req, url) => {
    if (url.pathname === "/v1/teardown") {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ ok: true, status: "removed" });
    }
    if (url.pathname === "/v1/deploy") {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        status: opts?.deployStatus ?? "running",
        preview_url: "https://pr-17.myapp.preview.example.com",
        canonical_repo_id: "https://gitlab.com/group/repo",
        pr_id: 17,
        slug: "myapp",
        db_name: "sprout_myapp_pr17",
        hostname: "pr-17.myapp.preview.example.com",
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
}

describe("sprout ci reset", () => {
  test("teardown then deploy, no rebuild, preview_url + dotenv + reset note", async () => {
    const baseUrl = resetGateway();
    const cwd = await withWorkspace(SEEDED_YAML, {
      "Dockerfile.seed": "FROM oven/bun:1.4.0\n",
    });
    const forgeCalls: { method: string; url: string; body: unknown }[] = [];
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_JOB_TOKEN: "job-token",
          CI_PROJECT_ID: "99",
        },
        readTextFile: readRealFile,
        now: () => new Date("2026-09-19T12:00:00.000Z").getTime(),
        fetchFn: async (url, init) => {
          forgeCalls.push({
            url,
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          if ((init?.method ?? "GET") === "GET") {
            return Response.json([]);
          }
          return Response.json({ id: 1 });
        },
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(dockerCalls).toEqual([]);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
    ]);
    expect(captured[0]?.body).toEqual({
      canonical_repo_id: "https://gitlab.com/group/repo",
      pr_id: 17,
    });
    expect(captured[1]?.body).toMatchObject({
      app_image: APP_REF,
      seed_image: COMMIT_SEED_REF,
    });
    expect(captured[1]?.body).not.toHaveProperty("reseed");
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
    expect(written).toEqual({
      [`${cwd}/sprout-preview.env`]:
        "PREVIEW_URL=https://pr-17.myapp.preview.example.com\n",
    });
    expect(forgeCalls).toHaveLength(2);
    const posted = JSON.stringify(forgeCalls[1]?.body ?? "");
    expect(posted).toContain(SPROUT_NOTE_MARKER);
    expect(posted).toContain("https://pr-17.myapp.preview.example.com");
    expect(posted).toContain("Reset: ada at 2026-09-19T12:00:00.000Z");
    expect(posted).toContain("data wiped");
  });

  test("second reset on a healthy preview succeeds", async () => {
    const baseUrl = resetGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const run = () =>
      runCli(
        ["ci", "reset"],
        deps({
          cwd,
          env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
          readTextFile: readRealFile,
        }),
      );
    expect(await run()).toBe(0);
    captured = [];
    stdout = [];
    expect(await run()).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
    ]);
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
  });

  test("teardown failure aborts before deploy", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/teardown") {
        captured.push({
          method: req.method,
          path: url.pathname,
          body: await req.json(),
          authorization: req.headers.get("authorization"),
        });
        return Response.json(
          { error: "preview_db_drop_failed" },
          { status: 500 },
        );
      }
      captured.push({
        method: req.method,
        path: url.pathname,
        body: null,
        authorization: null,
      });
      return Response.json({ ok: true });
    });
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["500 preview_db_drop_failed"]);
    expect(captured.map((c) => c.path)).toEqual(["/v1/teardown"]);
  });

  test("deploy failure dumps logs then exits with the deploy error", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (url.pathname === "/v1/teardown") {
        return Response.json({ ok: true, status: "removed" });
      }
      if (url.pathname === "/v1/deploy") {
        return Response.json({ ok: true, status: "starting" }, { status: 202 });
      }
      if (url.pathname === "/v1/preview") {
        return Response.json({
          ok: true,
          status: "failed",
          last_error: "seed_failed",
          last_error_detail: "exit=3",
        });
      }
      return Response.json({
        ok: true,
        canonical_repo_id: "https://gitlab.com/group/repo",
        pr_id: 17,
        tail: 200,
        app: "migrate: ok\n",
        seed: "seed: boom\n",
      });
    });
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toEqual(["=== app ===\nmigrate: ok\n=== seed ===\nseed: boom"]);
    expect(stderr).toEqual(["seed_failed: exit=3"]);
    expect(written).toEqual({});
  });

  test("rejects a non-positive --tail before any network call", async () => {
    const baseUrl = resetGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset", "--tail", "0"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["--tail must be a positive integer"]);
    expect(captured).toEqual([]);
    expect(dockerCalls).toEqual([]);
  });

  test("refuses detached pipelines before touching the gateway", async () => {
    const baseUrl = resetGateway();
    const code = await runCli(
      ["ci", "reset"],
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

  test("content-addressed seed ref deploys without any docker work", async () => {
    const baseUrl = resetGateway();
    const seedDockerfile = "FROM oven/bun:1.4.0\n";
    const cwd = await withWorkspace(
      `slug: myapp
build:
  dockerfile: Dockerfile
seed:
  dockerfile: Dockerfile.seed
  inputs:
    - Dockerfile.seed
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`,
      { "Dockerfile.seed": seedDockerfile },
    );
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(dockerCalls).toEqual([]);
    expect(captured).toHaveLength(2);
    const deployBody = captured[1]?.body as { seed_image?: string };
    expect(deployBody.seed_image).toMatch(
      /^registry\.gitlab\.com\/group\/repo:seed-[0-9a-f]{12}$/,
    );
  });

  test("reset edits the existing note in place, never a second note", async () => {
    const baseUrl = resetGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const forgeCalls: { method: string; url: string; body: unknown }[] = [];
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_JOB_TOKEN: "job-token",
          CI_PROJECT_ID: "99",
        },
        readTextFile: readRealFile,
        fetchFn: async (url, init) => {
          const method = init?.method ?? "GET";
          forgeCalls.push({
            url,
            method,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          if (method === "GET") {
            return Response.json([{ id: 7, body: `${SPROUT_NOTE_MARKER}\nold` }]);
          }
          return Response.json({ id: 7 });
        },
      }),
    );
    expect(code).toBe(0);
    expect(forgeCalls).toHaveLength(2);
    expect(forgeCalls[1]?.method).toBe("PUT");
    expect(String(forgeCalls[1]?.url)).toContain("/notes/7");
  });
});
