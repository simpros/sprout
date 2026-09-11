import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "./run.ts";
import { cliVersion } from "./version.ts";

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

function startGateway(handler: (req: Request, url: URL) => Response | Promise<Response>) {
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
  const dir = await mkdtemp(join(tmpdir(), "sprout-cli-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  return dir;
}

function deps(overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv }): CliDeps {
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

const MINIMAL_YAML = `
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`;

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

describe("sprout CLI command surface", () => {
  test("deploy shapes request from yaml and prints preview_url", async () => {
    const baseUrl = startGateway(async (req, url) => {
      const body = await req.json();
      captured.push({
        method: req.method,
        path: url.pathname,
        body,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({
        ok: true,
        status: "running",
        preview_url: "https://pr-42.myapp.preview.example.com",
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        slug: "myapp",
        db_name: "sprout_myapp_pr42",
        hostname: "pr-42.myapp.preview.example.com",
      });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
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
        readTextFile: async (path) =>
          path.endsWith(".sprout.yaml")
            ? await Bun.file(path).text()
            : null,
      }),
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([
      "preview_url=https://pr-42.myapp.preview.example.com",
    ]);
    expect(captured).toEqual([
      {
        method: "POST",
        path: "/v1/deploy",
        authorization: "Bearer deploy-token",
        body: {
          canonical_repo_id: "https://github.com/org/repo",
          pr_id: 42,
          slug: "myapp",
          hostname: "pr-42.myapp.preview.example.com",
          app_image: "ghcr.io/org/app:sha",
        },
      },
    ]);
  });

  test("deploy surfaces registry pull failure detail from gateway", async () => {
    const baseUrl = startGateway(async () => {
      return Response.json(
        {
          error: "preview_app_deploy_failed",
          detail: "access forbidden",
        },
        { status: 500 },
      );
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["deploy", "-i", "ghcr.io/org/private:sha"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "deploy-token",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/42/merge",
        },
        readTextFile: async (path) =>
          path.endsWith(".sprout.yaml")
            ? await Bun.file(path).text()
            : null,
      }),
    );

    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "500 preview_app_deploy_failed: access forbidden",
    );
  });

  test("deploy prints HTTP status and body on failure", async () => {
    const baseUrl = startGateway(async () =>
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const cwd = await withWorkspace(MINIMAL_YAML);
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
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["401 unauthorized"]);
  });

  test("deploy includes preview.env remap on the request body", async () => {
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
        preview_url: "https://pr-42.myapp.preview.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    PGHOST: DATABASE_HOST
    PGUSER: DATABASE_USER
`);
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
      }),
    );

    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      env: {
        PGHOST: "DATABASE_HOST",
        PGUSER: "DATABASE_USER",
      },
    });
  });

  test("deploy rejects invalid preview.env before calling the gateway", async () => {
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
  env:
    PGHOST: DATABASE_HOST
    PGPORT: DATABASE_HOST
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/1/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );

    expect(code).toBe(1);
    expect(stderr[0]).toContain("target collision");
    expect(captured).toEqual([]);
  });

  test("deploy forwards -s, --seed-env, --seed-arg and requires health", async () => {
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
        preview_url: "https://pr-7.example.com",
      });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const missingHealth = await runCli(
      ["deploy", "-i", "app:1", "-s", "seed:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/7/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(missingHealth).toBe(1);
    expect(stderr[0]).toContain("health block required");
    expect(captured).toEqual([]);

    const cwdHealth = await withWorkspace(HEALTH_YAML);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "-s",
        "seed:1",
        "--seed-env",
        "FIXTURE=demo",
        "--seed-arg",
        "--reset",
      ],
      deps({
        cwd: cwdHealth,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/7/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      seed_image: "seed:1",
      seed_env: ["FIXTURE=demo"],
      seed_arg: ["--reset"],
      health: {
        path: "/health",
        interval: "2s",
        timeout: "120s",
        expect: 200,
      },
    });
  });

  test("deploy forwards --app-env and preview.app_env (yaml then flags)", async () => {
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
  app_env:
    BETTER_AUTH_URL: "https://pr-static.example.com"
    SHARED: from-yaml
`);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "--app-env",
        "BETTER_AUTH_SECRET=sekrit",
        "--app-env",
        "SHARED=from-cli",
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
      app_env: [
        "BETTER_AUTH_URL=https://pr-static.example.com",
        "SHARED=from-cli",
        "BETTER_AUTH_SECRET=sekrit",
      ],
    });
    expect(captured[0]?.body).not.toHaveProperty("seed_env");
  });

  test("deploy rejects invalid --app-env before calling the gateway", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ ok: true, status: "running", preview_url: "x" });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["deploy", "-i", "app:1", "--app-env", "NOTAKEY"],
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
    expect(code).toBe(1);
    expect(stderr[0]).toBe("invalid --app-env: NOTAKEY");
    expect(captured).toEqual([]);
  });

  test("deploy forwards --app-env-file (yaml → file → flags)", async () => {
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
        preview_url: "https://pr-11.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    SHARED: from-yaml
    KEEP: yaml
`);
    await Bun.write(
      `${cwd}/preview.app.env`,
      `# ci secrets
SHARED=from-file
FILE_ONLY=1
`,
    );
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "--app-env-file",
        "preview.app.env",
        "--app-env",
        "SHARED=from-cli",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/11/merge",
        },
        readTextFile: async (path) => {
          const file = Bun.file(path);
          if (!(await file.exists())) return null;
          return file.text();
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      app_env: ["SHARED=from-cli", "KEEP=yaml", "FILE_ONLY=1"],
    });
  });

  test("deploy rejects invalid --app-env-file before calling the gateway", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ ok: true, status: "running", preview_url: "x" });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    await Bun.write(`${cwd}/bad.env`, "OK=1\nNOTAKEY\n");
    const code = await runCli(
      ["deploy", "-i", "app:1", "--app-env-file", "bad.env"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => {
          const file = Bun.file(path);
          if (!(await file.exists())) return null;
          return file.text();
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("invalid --app-env-file bad.env:2: NOTAKEY");
    expect(captured).toEqual([]);
  });

  test("teardown is idempotent exit 0 when preview absent", async () => {
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
      ["teardown"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          CI_MERGE_REQUEST_IID: "3",
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]).toMatchObject({
      path: "/v1/teardown",
      body: {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 3,
      },
    });
  });

  test("drop without --yes exits 2 and prints plan", async () => {
    const baseUrl = startGateway(async () => {
      return new Response(
        JSON.stringify({
          error: "confirmation_required",
          plan: {
            canonical_repo_id: "https://github.com/org/repo",
            pr_id: 9,
            slug: "myapp",
            db_name: "sprout_myapp_pr9",
            hostname: "pr-9.example.com",
            status: "running",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    });

    const code = await runCli(
      ["drop", "9"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "admin",
          GITHUB_REPOSITORY: "org/repo",
        },
      }),
    );
    expect(code).toBe(2);
    expect(stdout.join("\n")).toContain("confirmation_required");
    expect(stderr[0]).toContain("--yes");
  });

  test("list, doctor, and admin token commands send admin bearer token", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: req.method === "GET" ? null : await req.json().catch(() => null),
        authorization: req.headers.get("authorization"),
      });
      if (url.pathname === "/v1/previews") {
        return Response.json({ previews: [] });
      }
      if (url.pathname === "/v1/doctor") {
        return Response.json({ ok: true, postgres: "ok", docker: "ok", orphans: [] });
      }
      if (url.pathname === "/v1/drop" && req.method === "POST") {
        return Response.json({ ok: true, status: "removed" });
      }
      if (url.pathname === "/v1/admin/tokens" && req.method === "GET") {
        return Response.json({ tokens: [] });
      }
      if (url.pathname === "/v1/admin/tokens" && req.method === "POST") {
        return Response.json(
          {
            id: "hash",
            scope: "deploy",
            canonical_repo_id: "https://github.com/org/repo",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
            token: "raw-token",
          },
          { status: 201 },
        );
      }
      if (url.pathname.startsWith("/v1/admin/tokens/") && req.method === "DELETE") {
        return Response.json({ ok: true });
      }
      return new Response("no", { status: 404 });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const common = {
      cwd,
      env: {
        SPROUT_URL: baseUrl,
        SPROUT_TOKEN: "admin-token",
      },
      readTextFile: async (path: string) => Bun.file(path).text(),
    };

    expect(await runCli(["list"], deps(common))).toBe(0);
    expect(await runCli(["doctor"], deps(common))).toBe(0);
    expect(
      await runCli(["drop", "9", "--yes", "--repo", "https://github.com/org/repo"], deps(common)),
    ).toBe(0);
    expect(
      await runCli(
        [
          "admin",
          "token",
          "create",
          "--scope",
          "deploy",
          "--repo",
          "https://github.com/org/repo",
        ],
        deps(common),
      ),
    ).toBe(0);
    expect(
      await runCli(["admin", "token", "list"], deps(common)),
    ).toBe(0);
    expect(
      await runCli(["admin", "token", "revoke", "hash"], deps(common)),
    ).toBe(0);

    expect(captured.every((c) => c.authorization === "Bearer admin-token")).toBe(
      true,
    );
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/previews",
      "GET /v1/doctor",
      "POST /v1/drop",
      "POST /v1/admin/tokens",
      "GET /v1/admin/tokens",
      "DELETE /v1/admin/tokens/hash",
    ]);
    expect(captured[3]?.body).toEqual({
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
  });

  test("unknown command fails before requiring SPROUT_TOKEN", async () => {
    const code = await runCli(
      ["totally-bogus"],
      deps({ env: {} }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("unknown command: totally-bogus");
  });

  test("--version prints cliVersion without requiring SPROUT_TOKEN", async () => {
    const code = await runCli(["--version"], deps({ env: {} }));
    expect(code).toBe(0);
    expect(stdout).toEqual([cliVersion()]);
    expect(stderr).toEqual([]);
  });

  test("-V is an alias for --version", async () => {
    const code = await runCli(["-V"], deps({ env: {} }));
    expect(code).toBe(0);
    expect(stdout).toEqual([cliVersion()]);
  });

  test("local gateway accepts SPROUT_ADMIN_TOKEN when SPROUT_TOKEN is unset", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: null,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ previews: [] });
    });

    const code = await runCli(
      ["list"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_ADMIN_TOKEN: "container-admin",
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.authorization).toBe("Bearer container-admin");
  });

  test("local gateway accepts admin token file when env tokens are unset", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: null,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ previews: [] });
    });

    const code = await runCli(
      ["list"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_ADMIN_TOKEN_PATH: "/data/admin-token",
        },
        readTextFile: async (path) =>
          path === "/data/admin-token" ? "file-admin\n" : null,
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.authorization).toBe("Bearer file-admin");
  });

  test("remote gateway rejects SPROUT_ADMIN_TOKEN without SPROUT_TOKEN", async () => {
    const code = await runCli(
      ["list"],
      deps({
        env: {
          SPROUT_URL: "https://sprout.example",
          SPROUT_ADMIN_TOKEN: "container-admin",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("SPROUT_TOKEN is required");
  });

  test("invalid SPROUT_URL fails before admin fallback", async () => {
    const code = await runCli(
      ["list"],
      deps({
        env: {
          SPROUT_URL: "not-a-url",
          SPROUT_ADMIN_TOKEN: "container-admin",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("invalid SPROUT_URL");
  });

  test("admin token create requires explicit --repo even when CI derives one", async () => {
    const code = await runCli(
      ["admin", "token", "create", "--scope", "deploy"],
      deps({
        env: {
          SPROUT_TOKEN: "admin",
          GITHUB_REPOSITORY: "org/repo",
        },
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("--repo is required");
  });

  test("admin token create normalizes ssh --repo", async () => {
    const baseUrl = startGateway(async (req, url) => {
      captured.push({
        method: req.method,
        path: url.pathname,
        body: await req.json(),
        authorization: req.headers.get("authorization"),
      });
      return Response.json(
        {
          id: "hash",
          scope: "deploy",
          canonical_repo_id: "https://github.com/org/repo",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: null,
          token: "raw-token",
        },
        { status: 201 },
      );
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      [
        "admin",
        "token",
        "create",
        "--repo",
        "git@github.com:org/repo.git",
      ],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "admin" },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toEqual({
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
  });

  test("deploy normalizes ssh --repo override", async () => {
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
        preview_url: "https://pr-5.example.com",
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 5,
        slug: "myapp",
        db_name: "sprout_myapp_pr5",
        hostname: "pr-5.example.com",
      });
    });

    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "--repo",
        "git@github.com:org/repo.git",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REF: "refs/pull/5/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 5,
    });
  });

  test("admin token create forwards invalid .sprout.yaml errors", async () => {
    const cwd = await withWorkspace("slug: [broken");
    const code = await runCli(
      [
        "admin",
        "token",
        "create",
        "--repo",
        "https://github.com/org/repo",
      ],
      deps({
        cwd,
        env: { SPROUT_TOKEN: "admin" },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).not.toContain("--slug is required");
    expect(stderr[0]?.length).toBeGreaterThan(0);
  });

  test("broken GITHUB_EVENT_PATH is a hard error", async () => {
    const baseUrl = startGateway(async () => Response.json({ ok: true }));
    const code = await runCli(
      ["teardown"],
      deps({
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_PATH: "/tmp/sprout-missing-event.json",
          GITHUB_REF: "refs/pull/99/merge",
        },
        readTextFile: async () => null,
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("GITHUB_EVENT_PATH not readable");
  });
});
