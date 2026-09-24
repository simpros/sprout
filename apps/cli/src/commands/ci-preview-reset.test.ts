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

const MINIMAL_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`;

const GITLAB_MR_ENV = {
  CI_PROJECT_URL: "https://gitlab.com/group/repo",
  CI_MERGE_REQUEST_IID: "17",
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
  CI_COMMIT_SHA: "abc123",
};

const TICKED_BODY = [
  "Deploy this please.",
  "",
  "- [x] Sprout: reset preview",
  "<!-- sprout-reset: ada-1 -->",
].join("\n");

const UNTICKED_BODY = [
  "Deploy this please.",
  "",
  "- [ ] Sprout: reset preview",
  "<!-- sprout-reset: ada-1 -->",
].join("\n");

/** Fake gateway holding preview-row existence + handled marker in memory. */
function startStatefulGateway(initialMarker: string | null = null) {
  let rowExists = initialMarker !== null;
  let storedMarker: string | null = initialMarker;
  const snapshot = () => ({
    ok: true,
    status: "running",
    preview_url: "https://pr-17.myapp.preview.example.com",
    canonical_repo_id: "https://gitlab.com/group/repo",
    pr_id: 17,
    slug: "myapp",
    db_name: "sprout_myapp_pr17",
    hostname: "pr-17.myapp.preview.example.com",
    reset_request_marker: storedMarker,
  });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const handle = (async (): Promise<Response> => {
        if (url.pathname === "/v1/preview" && req.method === "GET") {
          if (!rowExists) {
            return Response.json({ error: "preview_not_found" }, { status: 404 });
          }
          return Response.json(snapshot());
        }
        if (url.pathname === "/v1/teardown") {
          captured.push({ method: req.method, path: url.pathname, body: await req.json() });
          rowExists = true;
          return Response.json({ ok: true, status: "removed" });
        }
        if (url.pathname === "/v1/deploy") {
          captured.push({ method: req.method, path: url.pathname, body: await req.json() });
          rowExists = true;
          return Response.json(snapshot());
        }
        if (url.pathname === "/v1/reset-marker") {
          const body = (await req.json()) as { marker?: string };
          captured.push({ method: req.method, path: url.pathname, body });
          if (!rowExists) {
            return Response.json({ error: "preview_not_found" }, { status: 404 });
          }
          storedMarker = body.marker ?? null;
          return Response.json(snapshot());
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      })();
      return handle;
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    getStoredMarker: () => storedMarker,
  };
}

async function withWorkspace(yaml: string, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sprout-ci-preview-reset-"));
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
    readTextFile: overrides.readTextFile ?? (async () => MINIMAL_YAML),
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

describe("sprout ci preview reset request", () => {
  test("tick + push resets exactly once; retry deploys without resetting", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const env = {
      SPROUT_URL: gw.baseUrl,
      SPROUT_TOKEN: "t",
      ...GITLAB_MR_ENV,
      CI_MERGE_REQUEST_DESCRIPTION: TICKED_BODY,
    };
    const run = () =>
      runCli(["ci", "preview"], deps({ cwd, env, readTextFile: readRealFile }));
    expect(await run()).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
      "/v1/reset-marker",
    ]);
    expect(gw.getStoredMarker()).toBe("ada-1");

    captured = [];
    stdout = [];
    expect(await run()).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
  });

  test("no marker leaves the preview path unchanged", async () => {
    startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: `http://127.0.0.1:${server!.port}`,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
  });

  test("unticked box leaves the preview path unchanged", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: UNTICKED_BODY,
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
  });

  test("already-handled marker deploys without resetting", async () => {
    const gw = startStatefulGateway("ada-1");
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: TICKED_BODY,
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
  });

  test("truncated GitLab description without a reset snippet deploys with a warning", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: "Just a long description with no reset snippet.",
          CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: "true",
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("truncated");
  });

  test("truncated GitLab description with a ticked box but no marker deploys then fails the reset path", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: "- [x] Sprout: reset preview",
          CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: "true",
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
    expect(stderr.join("\n")).toContain("truncated");
    expect(stderr.join("\n")).toContain("2700");
  });

  test("truncated GitLab description with a fully visible request still resets", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: TICKED_BODY,
          CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: "true",
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
      "/v1/reset-marker",
    ]);
    expect(gw.getStoredMarker()).toBe("ada-1");
  });
});

describe("sprout ci reset reset-request bookkeeping", () => {
  test("manual reset marks the current marker handled", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: TICKED_BODY,
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
      "/v1/reset-marker",
    ]);
    expect(gw.getStoredMarker()).toBe("ada-1");
  });

  test("manual reset without a marker issues no marker call", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: { SPROUT_URL: gw.baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
    ]);
  });

  test("manual reset with a truncated ticked box but no marker deploys then fails", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: "- [x] Sprout: reset preview",
          CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: "true",
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
    ]);
    expect(stderr.join("\n")).toContain("truncated");
    expect(stderr.join("\n")).toContain("2700");
  });

  test("manual reset with a truncated description and no reset box warns and exits 0", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "reset"],
      deps({
        cwd,
        env: {
          SPROUT_URL: gw.baseUrl,
          SPROUT_TOKEN: "t",
          ...GITLAB_MR_ENV,
          CI_MERGE_REQUEST_DESCRIPTION: "Just a long description with no reset snippet.",
          CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: "true",
        },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured.map((c) => c.path)).toEqual([
      "/v1/teardown",
      "/v1/deploy",
    ]);
    expect(stderr.join("\n")).toContain("truncated");
  });
});

describe("GitHub un-tick rewrite", () => {
  test("box flips to unticked with marker preserved; follow-up run does not reset", async () => {
    const gw = startStatefulGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const eventBody = JSON.stringify({
      pull_request: {
        number: 17,
        body: "- [x] Sprout: reset preview\n<!-- sprout-reset: gh-9 -->",
      },
    });
    await writeFile(join(cwd, "event.json"), eventBody);

    const prPatches: unknown[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/pulls/")) {
        prPatches.push(init?.body ? JSON.parse(String(init.body)) : null);
        return Response.json({});
      }
      if (method === "GET") return Response.json([]);
      return Response.json({ id: 1 });
    };
    const env = {
      SPROUT_URL: gw.baseUrl,
      SPROUT_TOKEN: "t",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "group/repo",
      GITHUB_SHA: "abc123",
      GITHUB_TOKEN: "gh-token",
      GITHUB_EVENT_PATH: join(cwd, "event.json"),
      CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
    };
    // Pre-seed the gateway row so the marker write lands on an existing row.
    const code = await runCli(
      ["ci", "preview"],
      deps({ cwd, env, readTextFile: readRealFile, fetchFn }),
    );
    expect(code).toBe(0);
    expect(
      captured.map((c) => c.path),
    ).toEqual(["/v1/teardown", "/v1/deploy", "/v1/reset-marker"]);
    expect(prPatches).toHaveLength(1);
    const rewritten = String(
      (prPatches[0] as { body?: unknown }).body ?? "",
    );
    expect(rewritten).toContain("- [ ] Sprout: reset preview");
    expect(rewritten).toContain("<!-- sprout-reset: gh-9 -->");
    expect(rewritten).not.toContain("[x] Sprout");

    // Follow-up run with the rewritten body: no reset.
    await writeFile(
      join(cwd, "event.json"),
      JSON.stringify({ pull_request: { number: 17, body: rewritten } }),
    );
    captured = [];
    prPatches.length = 0;
    const followUp = await runCli(
      ["ci", "preview"],
      deps({ cwd, env, readTextFile: readRealFile, fetchFn }),
    );
    expect(followUp).toBe(0);
    expect(captured.map((c) => c.path)).toEqual(["/v1/deploy"]);
    expect(prPatches).toEqual([]);
  });
});
