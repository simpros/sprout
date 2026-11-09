import { afterEach, describe, expect, test } from "bun:test";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { parseImageRef } from "./image-cleanup.ts";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  stdout = [];
  stderr = [];
});

const YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
seed:
  dockerfile: Dockerfile.seed
`;

function startGateway(): string {
  server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ ok: true, status: "removed" });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function deps(
  env: NodeJS.ProcessEnv,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): CliDeps {
  return {
    cwd: "/",
    readTextFile: async (path) => (path.endsWith(".sprout.yaml") ? YAML : null),
    getGitRemoteUrl: () => null,
    createClient: (baseUrl, token) =>
      createApiClient(baseUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    fetchFn,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env,
  };
}

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

const GITLAB_ENV: NodeJS.ProcessEnv = {
  SPROUT_TOKEN: "t",
  CI_PROJECT_URL: "https://gitlab.com/group/repo",
  CI_PROJECT_ID: "99",
  CI_MERGE_REQUEST_IID: "17",
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_JOB_TOKEN: "job-token",
  CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
  CI_COMMIT_SHA: "abc123",
};

function gitlabFetch(
  calls: FetchCall[],
  deleteStatus: (url: string) => number = () => 204,
) {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: headersOf(init) });
    if (url.includes("/registry/repositories?")) {
      return Response.json([{ id: 5, path: "group/repo" }]);
    }
    if (url.includes("/merge_requests/")) {
      if (method === "GET") return Response.json([]);
      return Response.json({ id: 1 });
    }
    if (method === "DELETE" && url.includes("/registry/repositories/5/tags/")) {
      return new Response(null, { status: deleteStatus(url) });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("ci teardown image tags", () => {
  test("deletes the app and seed tags pushed for the commit", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const code = await runCli(
      ["ci", "teardown"],
      deps(
        { ...GITLAB_ENV, SPROUT_URL: baseUrl },
        gitlabFetch(calls),
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual([
      "https://gitlab.com/api/v4/projects/99/registry/repositories/5/tags/abc123",
      "https://gitlab.com/api/v4/projects/99/registry/repositories/5/tags/abc123-seed",
    ]);
    expect(deletes[0]?.headers["job-token"]).toBe("job-token");
  });

  test("already-deleted tags warn and still exit 0", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const code = await runCli(
      ["ci", "teardown"],
      deps(
        { ...GITLAB_ENV, SPROUT_URL: baseUrl },
        gitlabFetch(calls, () => 404),
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([
      "warning: registry tag already absent: registry.gitlab.com/group/repo:abc123",
      "warning: registry tag already absent: registry.gitlab.com/group/repo:abc123-seed",
    ]);
  });

  test("a failed delete is a warning, never a teardown failure", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const code = await runCli(
      ["ci", "teardown"],
      deps(
        { ...GITLAB_ENV, SPROUT_URL: baseUrl },
        gitlabFetch(calls, () => 500),
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toHaveLength(2);
    expect(stderr[0]).toContain("warning: registry tag delete failed");
    expect(stderr[0]).toContain("500");
  });

  test("missing delete permission warns once with the missing scope", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const code = await runCli(
      ["ci", "teardown"],
      deps(
        { ...GITLAB_ENV, SPROUT_URL: baseUrl },
        gitlabFetch(calls, () => 403),
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("warning: registry tag delete is not authorized");
    expect(stderr[0]).toContain("api");
  });

  test("gateway failure skips registry cleanup", async () => {
    const calls: FetchCall[] = [];
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: "boom" }, { status: 500 });
      },
    });
    const code = await runCli(
      ["ci", "teardown"],
      deps(
        {
          ...GITLAB_ENV,
          SPROUT_URL: `http://127.0.0.1:${server.port}`,
        },
        gitlabFetch(calls),
      ),
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["500 boom"]);
    expect(calls).toEqual([]);
  });

  test("GHCR teardown deletes package versions carrying the SHA tags", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: headersOf(init) });
      if (url.includes("/issues/42/comments")) {
        if (method === "GET") return Response.json([]);
        return Response.json({ id: 1 });
      }
      if (url === "https://api.github.com/users/org") {
        return Response.json({ type: "Organization" });
      }
      if (
        method === "GET" &&
        url.includes("/orgs/org/packages/container/repo/versions")
      ) {
        return Response.json([
          {
            id: 11,
            metadata: { container: { tags: ["def456"] } },
          },
          {
            id: 12,
            metadata: { container: { tags: ["def456-seed"] } },
          },
        ]);
      }
      if (method === "DELETE" && url.includes("/versions/")) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };

    const code = await runCli(
      ["ci", "teardown"],
      deps(
        {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_SHA: "def456",
          GITHUB_TOKEN: "gh-token",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
        },
        fetchFn,
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual([
      "https://api.github.com/orgs/org/packages/container/repo/versions/11",
      "https://api.github.com/orgs/org/packages/container/repo/versions/12",
    ]);
    expect(deletes[0]?.headers.authorization).toBe("Bearer gh-token");
  });

  test("GHCR retries a refused delete with the job token", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = headersOf(init);
      calls.push({ url, method, headers });
      if (url.includes("/issues/42/comments")) {
        if (method === "GET") return Response.json([]);
        return Response.json({ id: 1 });
      }
      if (url === "https://api.github.com/users/org") {
        return Response.json({ type: "Organization" });
      }
      if (
        method === "GET" &&
        url.includes("/orgs/org/packages/container/repo/versions")
      ) {
        return Response.json([
          { id: 11, metadata: { container: { tags: ["def456"] } } },
          { id: 12, metadata: { container: { tags: ["def456-seed"] } } },
        ]);
      }
      if (method === "DELETE") {
        return new Response(null, {
          status:
            headers.authorization === "Bearer delete-token" ? 403 : 204,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const code = await runCli(
      ["ci", "teardown"],
      deps(
        {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_SHA: "def456",
          GITHUB_TOKEN: "gh-token",
          GHCR_DELETE_TOKEN: "delete-token",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
        },
        fetchFn,
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.headers.authorization)).toEqual([
      "Bearer delete-token",
      "Bearer gh-token",
      "Bearer delete-token",
      "Bearer gh-token",
    ]);
  });

  test("GHCR missing delete permission names delete:packages once", async () => {
    const calls: FetchCall[] = [];
    const baseUrl = startGateway();
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: headersOf(init) });
      if (url.includes("/issues/42/comments")) {
        if (method === "GET") return Response.json([]);
        return Response.json({ id: 1 });
      }
      if (url === "https://api.github.com/users/org") {
        return Response.json({ type: "Organization" });
      }
      if (
        method === "GET" &&
        url.includes("/orgs/org/packages/container/repo/versions")
      ) {
        return Response.json([
          { id: 11, metadata: { container: { tags: ["def456"] } } },
          { id: 12, metadata: { container: { tags: ["def456-seed"] } } },
        ]);
      }
      if (method === "DELETE") return new Response(null, { status: 403 });
      return new Response("not found", { status: 404 });
    };

    const code = await runCli(
      ["ci", "teardown"],
      deps(
        {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_SHA: "def456",
          GITHUB_TOKEN: "gh-token",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
        },
        fetchFn,
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("warning: registry tag delete is not authorized");
    expect(stderr[0]).toContain("delete:packages");
  });
});

describe("parseImageRef", () => {
  test("splits registry, repository, and tag", () => {
    expect(parseImageRef("registry.gitlab.com/group/repo:abc123")).toEqual({
      registry: "registry.gitlab.com",
      repository: "group/repo",
      tag: "abc123",
    });
  });

  test("keeps a registry port", () => {
    expect(parseImageRef("localhost:5000/app:sha")).toEqual({
      registry: "localhost:5000",
      repository: "app",
      tag: "sha",
    });
  });

  test("rejects a ref without a tag or registry host", () => {
    expect(parseImageRef("registry/app")).toBeNull();
    expect(parseImageRef("org/app:sha")).toBeNull();
  });
});
