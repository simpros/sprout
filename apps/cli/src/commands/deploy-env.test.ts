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
  const dir = await mkdtemp(join(tmpdir(), "sprout-cli-deploy-env-"));
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

function readExisting(path: string): Promise<string | null> {
  return (async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return file.text();
  })();
}

describe("deploy app/seed env wiring", () => {
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
      app_env: expect.arrayContaining([
        "BETTER_AUTH_URL=https://pr-static.example.com",
        "BETTER_AUTH_SECRET=sekrit",
        "SHARED=from-cli",
      ]),
    });
    expect(captured[0]?.body).not.toHaveProperty("seed_env");
  });

  test("deploy expands app_env placeholders and stable_per_pr secrets", async () => {
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
    BETTER_AUTH_URL: "https://{hostname}"
    REF: "{commit_sha}"
    BETTER_AUTH_SECRET:
      generate: stable_per_pr
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
          GITHUB_SHA: "deadbeef",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      app_env: [
        "BETTER_AUTH_URL=https://pr-9.example.com",
        "REF=deadbeef",
        // HMAC-SHA256("t", "sprout-stable-per-pr:https://github.com/org/repo:9:BETTER_AUTH_SECRET")
        "BETTER_AUTH_SECRET=KrLonl37dtv_WiT_yVTw01CIOI0nfVFcQT4oectt8bE",
      ],
    });
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

  test("deploy fails fast on unknown app_env placeholder", async () => {
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
    ORIGIN: "https://{host}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
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
    expect(stderr[0]).toBe(
      "preview.app_env.ORIGIN: unknown placeholder {host}",
    );
    expect(captured).toEqual([]);
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
    expect(stderr[0]).toBe("invalid --app-env (expected KEY=VALUE)");
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
        readTextFile: readExisting,
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
        readTextFile: readExisting,
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "invalid --app-env-file bad.env:2: expected KEY=VALUE",
    );
    expect(captured).toEqual([]);
  });

  test("deploy reads one masked file-type SPROUT_APP_ENV blob", async () => {
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
        preview_url: "https://pr-12.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    BETTER_AUTH_URL: "https://{hostname}"
    BETTER_AUTH_SECRET:
      generate: stable_per_pr
    STRIPE_API_KEY:
      required: true
`);
    await Bun.write(
      `${cwd}/secrets.env`,
      `# masked file-type CI variable
export STRIPE_API_KEY=sk_live_abc123
`,
    );
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
          GITHUB_SHA: "deadbeef",
          SPROUT_APP_ENV: `${cwd}/secrets.env`,
        },
        readTextFile: readExisting,
      }),
    );

    expect(code).toBe(0);
    const body = captured[0]?.body as { app_env: string[] };
    expect(body.app_env).toContain(
      "BETTER_AUTH_URL=https://pr-12.example.com",
    );
    expect(body.app_env).toContain("STRIPE_API_KEY=sk_live_abc123");
    expect(body.app_env.some((e) => e.startsWith("BETTER_AUTH_SECRET="))).toBe(
      true,
    );
    // Secrets never reach stdout or stderr (job log).
    expect(stdout).toEqual(["preview_url=https://pr-12.example.com"]);
    expect(stdout.join("\n")).not.toContain("sk_live_abc123");
    expect(stderr.join("\n")).not.toContain("sk_live_abc123");
  });

  test("deploy fails naming a required app_env key that CI did not supply", async () => {
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
    STRIPE_API_KEY:
      required: true
`);
    await Bun.write(`${cwd}/secrets.env`, "OTHER=1\n");
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
          SPROUT_APP_ENV: `${cwd}/secrets.env`,
        },
        readTextFile: readExisting,
      }),
    );

    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.app_env.STRIPE_API_KEY: required value missing (supply it via --app-env-file, SPROUT_APP_ENV, or --app-env)",
    );
    expect(captured).toEqual([]);
  });

  test("deploy fails naming an unreadable SPROUT_APP_ENV path", async () => {
    const baseUrl = startGateway(async () => {
      return Response.json({ ok: true, status: "running", preview_url: "x" });
    });
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
          SPROUT_APP_ENV: "/nope/secrets.env",
        },
        readTextFile: readExisting,
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe("cannot read SPROUT_APP_ENV: /nope/secrets.env");
    expect(captured).toEqual([]);
  });

  test("deploy reads --seed-env-file and templates seed values", async () => {
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
        preview_url: "https://pr-12.example.com",
      });
    });

    const cwd = await withWorkspace(HEALTH_YAML);
    await Bun.write(
      `${cwd}/seed.env`,
      "export FIXTURE_SET=demo\nSEED_URL=https://{hostname}\n",
    );
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "-s",
        "seed:1",
        "--seed-env-file",
        "seed.env",
        "--seed-env",
        "FIXTURE_SET=flag",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
        },
        readTextFile: readExisting,
      }),
    );

    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      seed_env: [
        "FIXTURE_SET=flag",
        "SEED_URL=https://pr-12.myapp.preview.example.com",
      ],
    });
  });

  test("deploy merges yaml seed.env (templated) then file then flags", async () => {
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
        preview_url: "https://pr-12.example.com",
      });
    });

    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: yaml
    SEED_URL: "https://{hostname}"
    SEED_SECRET:
      generate: stable_per_pr
`);
    const code = await runCli(
      [
        "deploy",
        "-i",
        "app:1",
        "-s",
        "seed:1",
        "--seed-env",
        "FIXTURE_SET=flag",
      ],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
        },
        readTextFile: readExisting,
      }),
    );

    expect(code).toBe(0);
    const body = captured[0]?.body as { seed_env: string[] };
    expect(body.seed_env).toContain("FIXTURE_SET=flag");
    expect(body.seed_env).toContain(
      "SEED_URL=https://pr-12.myapp.preview.example.com",
    );
    expect(body.seed_env.some((e) => e.startsWith("SEED_SECRET="))).toBe(true);
  });

  test("deploy fails naming a required seed.env key that CI did not supply", async () => {
    const baseUrl = startGateway(async () => {
      return Response.json({ ok: true, status: "running", preview_url: "x" });
    });
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    SEED_SECRET:
      required: true
`);
    const code = await runCli(
      ["deploy", "-i", "app:1", "-s", "seed:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
        },
        readTextFile: readExisting,
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "seed.env.SEED_SECRET: required value missing (supply it via --seed-env-file, SPROUT_SEED_ENV, or --seed-env)",
    );
    expect(captured).toEqual([]);
  });

  test("deploy layers yaml seed.args first, then --seed-arg flags", async () => {
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
        preview_url: "https://pr-12.example.com",
      });
    });
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  args:
    - --reset
`);
    const code = await runCli(
      ["deploy", "-i", "app:1", "-s", "seed:1", "--seed-arg", "--fixtures=demo"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
        },
        readTextFile: readExisting,
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).toMatchObject({
      seed_arg: ["--reset", "--fixtures=demo"],
    });
  });

  test("deploy without -s omits yaml seed env/args (omit-s-on-sync)", async () => {
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
        preview_url: "https://pr-12.example.com",
      });
    });
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
  args:
    - --reset
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/12/merge",
        },
        readTextFile: readExisting,
      }),
    );
    expect(code).toBe(0);
    expect(captured[0]?.body).not.toHaveProperty("seed_env");
    expect(captured[0]?.body).not.toHaveProperty("seed_arg");
    expect(captured[0]?.body).not.toHaveProperty("seed_image");
  });
});
