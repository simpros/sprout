import { describe, expect, test } from "bun:test";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import {
  buildPreviewNote,
  buildTeardownNote,
  SPROUT_NOTE_MARKER,
  upsertForgeNote,
} from "./forge-note.ts";

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function baseDeps(
  env: NodeJS.ProcessEnv,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<CliDeps> = {},
): CliDeps {
  return {
    cwd: "/",
    readTextFile: async () => null,
    getGitRemoteUrl: () => null,
    createClient: (baseUrl, token) =>
      createApiClient(baseUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    io: { stdout: () => {}, stderr: () => {} },
    fetchFn,
    env,
    ...overrides,
  };
}

const GITLAB_IDENTITY = {
  forge: "gitlab" as const,
  repo: "https://gitlab.com/group/repo",
  prId: 17,
  pipelineSource: "merge_request_event" as const,
};

const GITHUB_IDENTITY = {
  forge: "github" as const,
  repo: "https://github.com/org/repo",
  prId: 42,
  pipelineSource: "pull_request" as const,
};

describe("buildPreviewNote", () => {
  test("carries marker, URL, short SHA, health, and logs hint", () => {
    const body = buildPreviewNote({
      previewUrl: "https://pr-17.example.com",
      sha: "abc123456789",
      prId: 17,
    });
    expect(body).toContain(SPROUT_NOTE_MARKER);
    expect(body).toContain("https://pr-17.example.com");
    expect(body).toContain("`abc1234`");
    expect(body).not.toContain("abc123456789");
    expect(body).toContain("healthy");
    expect(body).toContain("sprout ci logs 17");
  });
});

describe("buildTeardownNote", () => {
  test("reuses the marker and says removed, not deleted", () => {
    const body = buildTeardownNote({ prId: 17 });
    expect(body).toContain(SPROUT_NOTE_MARKER);
    expect(body).toContain("removed");
    expect(body).not.toContain("deleted");
  });
});

describe("upsertForgeNote (GitLab)", () => {
  test("creates when no sprout note exists", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse([{ id: 1, body: "hello" }]);
      }
      return jsonResponse({ id: 2 });
    };
    const result = await upsertForgeNote(
      baseDeps(
        { CI_JOB_TOKEN: "job-token", CI_PROJECT_ID: "99" },
        fetchFn,
      ),
      GITLAB_IDENTITY,
      buildPreviewNote({ previewUrl: "https://x", prId: 17 }),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/projects/99/merge_requests/17/notes");
    expect(calls[1]?.method).toBe("POST");
    expect(String(calls[1]?.url)).toContain("/notes");
    expect(calls[1]?.body).toMatchObject({
      body: expect.stringContaining(SPROUT_NOTE_MARKER),
    });
  });

  test("two consecutive runs edit the same note (PUT, not POST)", async () => {
    let stored = "first";
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ?? null });
      if (method === "GET") {
        return jsonResponse(
          stored === "first"
            ? []
            : [{ id: 7, body: `${SPROUT_NOTE_MARKER}\nfirst` }],
        );
      }
      if (method === "POST") {
        stored = "second";
        return jsonResponse({ id: 7 });
      }
      return jsonResponse({ id: 7 });
    };
    const deps = (env: NodeJS.ProcessEnv) =>
      baseDeps(env, fetchFn);
    const first = await upsertForgeNote(
      deps({ CI_JOB_TOKEN: "t", CI_PROJECT_ID: "99" }),
      GITLAB_IDENTITY,
      `${SPROUT_NOTE_MARKER}\nfirst`,
    );
    expect(first.ok).toBe(true);
    expect(calls[1]?.method).toBe("POST");
    calls.length = 0;
    const second = await upsertForgeNote(
      deps({ CI_JOB_TOKEN: "t", CI_PROJECT_ID: "99" }),
      GITLAB_IDENTITY,
      `${SPROUT_NOTE_MARKER}\nsecond`,
    );
    expect(second.ok).toBe(true);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PUT");
    expect(String(calls[1]?.url)).toContain("/notes/7");
  });

  test("forge rejection carries the error body", async () => {
    const fetchFn = async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse([]);
      return textResponse("forbidden: cannot comment", 403);
    };
    const result = await upsertForgeNote(
      baseDeps({ CI_JOB_TOKEN: "t", CI_PROJECT_ID: "99" }, fetchFn),
      GITLAB_IDENTITY,
      "body",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("403");
      expect(result.error).toContain("forbidden");
    }
  });

  test("missing token skips without error", async () => {
    let called = false;
    const result = await upsertForgeNote(
      baseDeps({}, async () => {
        called = true;
        return jsonResponse([]);
      }),
      GITLAB_IDENTITY,
      "body",
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(called).toBe(false);
  });

  test("never includes the token in errors", async () => {
    const fetchFn = async () => textResponse("nope", 500);
    const result = await upsertForgeNote(
      baseDeps({ CI_JOB_TOKEN: "super-secret-token", CI_PROJECT_ID: "99" }, fetchFn),
      GITLAB_IDENTITY,
      "body",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("super-secret-token");
  });

  test("finds the marker past page one instead of stacking a note", async () => {
    const calls: FetchCall[] = [];
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      body: `filler ${i}`,
    }));
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ?? null });
      if (method === "GET") {
        if (url.endsWith("page=1")) {
          return new Response(JSON.stringify(pageOne), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-next-page": "2",
            },
          });
        }
        return jsonResponse([{ id: 7, body: `${SPROUT_NOTE_MARKER}\nold` }]);
      }
      return jsonResponse({ id: 7 });
    };
    const result = await upsertForgeNote(
      baseDeps({ CI_JOB_TOKEN: "t", CI_PROJECT_ID: "99" }, fetchFn),
      GITLAB_IDENTITY,
      `${SPROUT_NOTE_MARKER}\nnew`,
    );
    expect(result.ok).toBe(true);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PUT");
    expect(String(writes[0]?.url)).toContain("/notes/7");
  });

  test("job token travels in JOB-TOKEN only, PAT in PRIVATE-TOKEN only", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      if ((init?.method ?? "GET") === "GET") return jsonResponse([]);
      return jsonResponse({ id: 1 });
    };
    await upsertForgeNote(
      baseDeps({ CI_JOB_TOKEN: "job-token", CI_PROJECT_ID: "99" }, fetchFn),
      GITLAB_IDENTITY,
      "body",
    );
    expect(seen[0]?.["JOB-TOKEN"]).toBe("job-token");
    expect(seen[0]?.["PRIVATE-TOKEN"]).toBeUndefined();

    seen.length = 0;
    await upsertForgeNote(
      baseDeps({ GITLAB_TOKEN: "glpat-x", CI_PROJECT_ID: "99" }, fetchFn),
      GITLAB_IDENTITY,
      "body",
    );
    expect(seen[0]?.["PRIVATE-TOKEN"]).toBe("glpat-x");
    expect(seen[0]?.["JOB-TOKEN"]).toBeUndefined();
  });

  test("fails fast without host guessing when project ids are absent", async () => {
    let called = false;
    const result = await upsertForgeNote(
      baseDeps({ CI_JOB_TOKEN: "t" }, async () => {
        called = true;
        return jsonResponse([]);
      }),
      GITLAB_IDENTITY,
      "body",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("CI_PROJECT_ID");
    expect(called).toBe(false);
  });
});

describe("upsertForgeNote (GitHub)", () => {
  test("creates when no sprout comment exists", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse([{ id: 1, body: "other" }]);
      }
      return jsonResponse({ id: 2 });
    };
    const result = await upsertForgeNote(
      baseDeps(
        { GITHUB_TOKEN: "gh-token", GITHUB_REPOSITORY: "org/repo" },
        fetchFn,
      ),
      GITHUB_IDENTITY,
      buildPreviewNote({ previewUrl: "https://x", prId: 42 }),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls[0]?.url).toContain("/repos/org/repo/issues/42/comments");
    expect(calls[1]?.method).toBe("POST");
  });

  test("updates the existing sprout comment in place (PATCH)", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ?? null });
      if (method === "GET") {
        return jsonResponse([
          { id: 1, body: "unrelated" },
          { id: 9, body: `${SPROUT_NOTE_MARKER}\nold` },
        ]);
      }
      return jsonResponse({ id: 9 });
    };
    const result = await upsertForgeNote(
      baseDeps(
        { GITHUB_TOKEN: "gh-token", GITHUB_REPOSITORY: "org/repo" },
        fetchFn,
      ),
      GITHUB_IDENTITY,
      buildTeardownNote({ prId: 42 }),
    );
    expect(result.ok).toBe(true);
    expect(calls[1]?.method).toBe("PATCH");
    expect(String(calls[1]?.url)).toContain("/comments/9");
    const raw = String(calls[1]?.body ?? "");
    expect(raw).toContain(SPROUT_NOTE_MARKER);
    expect(raw).toContain("removed");
  });

  test("missing token skips without error", async () => {
    let called = false;
    const result = await upsertForgeNote(
      baseDeps({}, async () => {
        called = true;
        return jsonResponse([]);
      }),
      GITHUB_IDENTITY,
      "body",
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(called).toBe(false);
  });

  test("follows Link rel=next to the marked comment", async () => {
    const calls: FetchCall[] = [];
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      id: 2000 + i,
      body: `filler ${i}`,
    }));
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ?? null });
      if (method === "GET") {
        if (url.endsWith("page=1")) {
          return new Response(JSON.stringify(pageOne), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: `<https://api.github.com/repos/org/repo/issues/42/comments?per_page=100&page=2>; rel="next"`,
            },
          });
        }
        return jsonResponse([{ id: 9, body: `${SPROUT_NOTE_MARKER}\nold` }]);
      }
      return jsonResponse({ id: 9 });
    };
    const result = await upsertForgeNote(
      baseDeps(
        { GITHUB_TOKEN: "gh-token", GITHUB_REPOSITORY: "org/repo" },
        fetchFn,
      ),
      GITHUB_IDENTITY,
      buildTeardownNote({ prId: 42 }),
    );
    expect(result.ok).toBe(true);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PATCH");
    expect(String(writes[0]?.url)).toContain("/comments/9");
  });
});

describe("ci preview/teardown note wiring", () => {
  const MINIMAL_YAML = `slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`;

  function gateway(baseUrl: string, handler: (req: Request, url: URL) => Response | Promise<Response>) {
    return baseUrl;
  }

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
      void gateway;
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
          fetchFn: async (url, init) => {
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
