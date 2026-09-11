import { afterEach, describe, expect, test } from "bun:test";
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

describe("sprout logs", () => {
  test("resolves repo like drop and prints app/seed sections", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: Object.fromEntries(url.searchParams),
        authorization: req.headers.get("authorization"),
      });
      if (
        url.pathname === "/v1/previews/42/logs" &&
        req.method === "GET"
      ) {
        return Response.json({
          ok: true,
          canonical_repo_id: "https://github.com/org/repo",
          pr_id: 42,
          tail: 50,
          app: "hello app\n",
          seed: "hello seed\n",
        });
      }
      return new Response("no", { status: 404 });
    });

    const code = await runCli(
      [
        "logs",
        "42",
        "--tail",
        "50",
        "--repo",
        "https://github.com/org/repo",
      ],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured).toEqual([
      {
        method: "GET",
        path: "/v1/previews/42/logs",
        body: {
          canonical_repo_id: "https://github.com/org/repo",
          tail: "50",
        },
        authorization: "Bearer deploy-token",
      },
    ]);
    expect(stdout).toEqual([
      "=== app ===\nhello app\n=== seed ===\nhello seed",
    ]);
  });

  test("omits seed section when seed logs are empty", async () => {
    const baseUrl = startGateway(async () =>
      Response.json({
        ok: true,
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 7,
        tail: 100,
        app: "only app\n",
        seed: "",
      }),
    );
    const code = await runCli(
      ["logs", "7", "--repo", "https://github.com/org/repo"],
      deps({
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t" },
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["=== app ===\nonly app"]);
  });
});
