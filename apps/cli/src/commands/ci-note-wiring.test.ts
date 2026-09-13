import { describe, expect, test } from "bun:test";
import { createApiClient } from "@sprout/api-client";
import { runCli } from "../run.ts";
import { SPROUT_NOTE_MARKER } from "./forge-note.ts";

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

describe("ci preview/teardown note wiring", () => {
  const MINIMAL_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`;

  test("preview posts the MR note and stays green", async () => {
    const forgeCalls: FetchCall[] = [];
    const forgeFetch = async (url: string, init?: RequestInit) => {
      forgeCalls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if ((init?.method ?? "GET") === "GET") return jsonResponse([]);
      return jsonResponse({ id: 1 });
    };
    let server: ReturnType<typeof Bun.serve> | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/v1/deploy") {
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
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const code = await runCli(
        ["ci", "preview"],
        {
          cwd: "/",
          readTextFile: async (path) =>
            path.endsWith(".sprout.yaml") ? MINIMAL_YAML : null,
          getGitRemoteUrl: () => null,
          createClient: (bu, tok) =>
            createApiClient(bu, {
              headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
            }),
          runCommand: async () => ({ exitCode: 0 }),
          writeTextFile: async () => {},
          fetchFn: forgeFetch,
          io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) },
          env: {
            SPROUT_URL: baseUrl,
            SPROUT_TOKEN: "t",
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_PROJECT_ID: "99",
            CI_JOB_TOKEN: "job-token",
            CI_MERGE_REQUEST_IID: "17",
            CI_PIPELINE_SOURCE: "merge_request_event",
            CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
            CI_COMMIT_SHA: "abc123456",
          },
        },
      );
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(forgeCalls).toHaveLength(2);
      const posted = JSON.stringify(forgeCalls[1]?.body ?? "");
      expect(posted).toContain("https://pr-17.myapp.preview.example.com");
      expect(posted).toContain("abc1234");
      expect(posted).toContain("sprout ci logs 17");
    } finally {
      server?.stop(true);
    }
  });

  test("preview note failure is non-fatal with the forge body", async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    const stderr: string[] = [];
    try {
      server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/v1/deploy") {
            return Response.json({
              ok: true,
              status: "running",
              preview_url: "https://pr-17.example.com",
              canonical_repo_id: "https://gitlab.com/group/repo",
              pr_id: 17,
              slug: "myapp",
              db_name: "sprout_myapp_pr17",
              hostname: "pr-17.example.com",
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const code = await runCli(
        ["ci", "preview"],
        {
          cwd: "/",
          readTextFile: async (path) =>
            path.endsWith(".sprout.yaml") ? MINIMAL_YAML : null,
          getGitRemoteUrl: () => null,
          createClient: (bu, tok) =>
            createApiClient(bu, {
              headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
            }),
          runCommand: async () => ({ exitCode: 0 }),
          writeTextFile: async () => {},
          fetchFn: async (_url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse([]);
            return textResponse("rate limited", 429);
          },
          io: { stdout: () => {}, stderr: (l) => stderr.push(l) },
          env: {
            SPROUT_URL: baseUrl,
            SPROUT_TOKEN: "t",
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_PROJECT_ID: "99",
            CI_JOB_TOKEN: "job-token",
            CI_MERGE_REQUEST_IID: "17",
            CI_PIPELINE_SOURCE: "merge_request_event",
            CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
            CI_COMMIT_SHA: "abc",
          },
        },
      );
      expect(code).toBe(0);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain("warning: MR note update failed");
      expect(stderr[0]).toContain("429");
      expect(stderr[0]).toContain("rate limited");
      expect(stderr[0]).not.toContain("job-token");
    } finally {
      server?.stop(true);
    }
  });

  test("teardown rewrites the same note as removed", async () => {
    const forgeCalls: FetchCall[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    const stderr: string[] = [];
    try {
      server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/v1/teardown") {
            return Response.json({ ok: true, status: "removed" });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const code = await runCli(
        ["ci", "teardown"],
        {
          cwd: "/",
          readTextFile: async () => null,
          getGitRemoteUrl: () => null,
          createClient: (bu, tok) =>
            createApiClient(bu, {
              headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
            }),
          fetchFn: async (url, init) => {
            const method = init?.method ?? "GET";
            forgeCalls.push({
              url,
              method,
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            if (method === "GET") {
              return jsonResponse([{ id: 5, body: `${SPROUT_NOTE_MARKER}\nold` }]);
            }
            return jsonResponse({ id: 5 });
          },
          io: { stdout: () => {}, stderr: (l) => stderr.push(l) },
          env: {
            SPROUT_URL: baseUrl,
            SPROUT_TOKEN: "t",
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_PROJECT_ID: "99",
            CI_JOB_TOKEN: "job-token",
            CI_MERGE_REQUEST_IID: "17",
            CI_PIPELINE_SOURCE: "merge_request_event",
          },
        },
      );
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(forgeCalls[1]?.method).toBe("PUT");
      const posted = JSON.stringify(forgeCalls[1]?.body ?? "");
      expect(posted).toContain("removed");
    } finally {
      server?.stop(true);
    }
  });
});
