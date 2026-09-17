import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { shortSeedHash } from "./seed-image.ts";

type Captured = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let captured: Captured[] = [];
let dockerCalls: string[][] = [];
// Absent tag by default: `manifest inspect` fails so the seed builds —
// tests opt into the reuse path by returning 0 for it.
let dockerBehavior: (argv: string[]) => number = (argv) =>
  argv[1] === "manifest" ? 1 : 0;
let written: Record<string, string> = {};
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  captured = [];
  dockerCalls = [];
  dockerBehavior = (argv) => (argv[1] === "manifest" ? 1 : 0);
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

async function withWorkspace(
  yaml: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-ci-preview-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Production-faithful file seam: missing files read as null, not a throw. */
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

const SEEDED_INPUTS_YAML = `slug: myapp
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
`;

const GITLAB_MR_ENV = {
  CI_PROJECT_URL: "https://gitlab.com/group/repo",
  CI_MERGE_REQUEST_IID: "17",
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
  CI_COMMIT_SHA: "abc123",
};

const APP_REF = "registry.gitlab.com/group/repo:abc123";

// Explicit `seed.inputs`: content-addressed tag over the listed paths.
function seedRefFor(content: string): string {
  return `registry.gitlab.com/group/repo:seed-${shortSeedHash([
    { path: "Dockerfile.seed", content },
  ])}`;
}

const SEED_DOCKERFILE = "FROM oven/bun:1.4.0\n";
// No `seed.inputs`: commit-scoped tag, always rebuilt, never probed.
const COMMIT_SEED_REF = `${APP_REF}-seed`;

const SEED_REF = seedRefFor(SEED_DOCKERFILE);

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

describe("sprout ci preview", () => {
  test("success builds + pushes app and seed, deploys with -s, writes dotenv", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(SEEDED_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    // No `seed.inputs`: commit-scoped tag, always rebuilt, never probed.
    // The seed ensures before the app build so bad inputs fail with no
    // docker work at all.
    expect(dockerCalls).toEqual([
      ["docker", "build", "-f", "Dockerfile.seed", "-t", COMMIT_SEED_REF, "."],
      ["docker", "push", COMMIT_SEED_REF],
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      canonical_repo_id: "https://gitlab.com/group/repo",
      pr_id: 17,
      slug: "myapp",
      hostname: "pr-17.myapp.preview.example.com",
      app_image: APP_REF,
      seed_image: COMMIT_SEED_REF,
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
        readTextFile: readRealFile,
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

  test("seed build failure exits before app build or deploy", async () => {
    const baseUrl = healthyGateway();
    dockerBehavior = (argv) => {
      if (argv[1] === "manifest") return 1;
      return argv.includes("Dockerfile.seed") ? 1 : 0;
    };
    const cwd = await withWorkspace(SEEDED_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["seed image build failed (exit 1)"]);
    expect(stdout).toEqual([]);
    // The seed ensures first, so the app never builds and nothing deploys.
    expect(dockerCalls).toEqual([
      ["docker", "build", "-f", "Dockerfile.seed", "-t", COMMIT_SEED_REF, "."],
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toContain("health block required");
    expect(dockerCalls).toEqual([]);
    expect(captured).toEqual([]);
  });

  test("seed env/args from the manifest reach the deploy body", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(
      `slug: myapp
build:
  dockerfile: Dockerfile
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
    SEED_URL: "https://{hostname}"
  args:
    - --reset
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`,
      { "Dockerfile.seed": SEED_DOCKERFILE },
    );
    const code = await runCli(
      ["ci", "preview", "--seed-arg", "--fixtures=demo"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: APP_REF,
      seed_image: COMMIT_SEED_REF,
      seed_env: [
        "FIXTURE_SET=demo",
        "SEED_URL=https://pr-17.myapp.preview.example.com",
      ],
      seed_arg: ["--reset", "--fixtures=demo"],
    });
  });

  test("rejects a non-positive --tail before building", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview", "--tail", "0"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
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
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: "registry.gitlab.com/group/repo:aaa",
      app_env: ["REF=aaa"],
    });
  });

  test("unchanged seed inputs skip seed build + push and log the reuse", async () => {
    const baseUrl = healthyGateway();
    dockerBehavior = (argv) => {
      if (argv[1] === "manifest") return 0;
      return argv.includes("Dockerfile.seed") ? 1 : 0;
    };
    const cwd = await withWorkspace(SEEDED_INPUTS_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    // Seed build/push would exit 1 here — their absence proves the skip.
    // The seed probes before the app builds.
    expect(dockerCalls).toEqual([
      ["docker", "manifest", "inspect", SEED_REF],
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
    ]);
    expect(stdout).toEqual([
      `seed image reused: ${SEED_REF}`,
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: APP_REF,
      seed_image: SEED_REF,
    });
    expect(written[`${cwd}/sprout-preview.env`]).toBe(
      "PREVIEW_URL=https://pr-17.myapp.preview.example.com\n",
    );
  });

  test("without seed inputs the registry is never probed: always rebuild", async () => {
    const baseUrl = healthyGateway();
    // Even a present tag must not skip the seed build — reuse is opt-in on
    // explicit `seed.inputs`. A probe hit here would wrongly reuse a stale
    // image after an entrypoint / seed-script change.
    dockerBehavior = (argv) => {
      if (argv[1] === "manifest") return 0;
      return 0;
    };
    const cwd = await withWorkspace(SEEDED_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(dockerCalls).toEqual([
      [
        "docker",
        "build",
        "-f",
        "Dockerfile.seed",
        "-t",
        COMMIT_SEED_REF,
        ".",
      ],
      ["docker", "push", COMMIT_SEED_REF],
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
    ]);
    expect(stdout).toEqual([
      "preview_url=https://pr-17.myapp.preview.example.com",
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: APP_REF,
      seed_image: COMMIT_SEED_REF,
    });
  });

  test("changed seed inputs produce a new tag and build + push", async () => {
    const baseUrl = healthyGateway();
    const first = await withWorkspace(SEEDED_INPUTS_YAML, {
      "Dockerfile.seed": "FROM oven/bun:1.4.0\n",
    });
    const second = await withWorkspace(SEEDED_INPUTS_YAML, {
      "Dockerfile.seed": "FROM oven/bun:1.5.0\n",
    });
    const run = (cwd: string) =>
      runCli(
        ["ci", "preview"],
        deps({
          cwd,
          env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
          readTextFile: readRealFile,
        }),
      );
    expect(await run(first)).toBe(0);
    const firstSeedBuilds = dockerCalls.filter(
      (argv) => argv[1] === "build" && argv.includes("Dockerfile.seed"),
    );
    expect(firstSeedBuilds).toHaveLength(1);
    const firstRef = firstSeedBuilds[0]?.[5];
    dockerCalls = [];
    captured = [];
    expect(await run(second)).toBe(0);
    const secondSeedBuilds = dockerCalls.filter(
      (argv) => argv[1] === "build" && argv.includes("Dockerfile.seed"),
    );
    expect(secondSeedBuilds).toHaveLength(1);
    const secondRef = secondSeedBuilds[0]?.[5];
    expect(firstRef).not.toEqual(secondRef);
    expect(secondRef).toMatch(/^registry\.gitlab\.com\/group\/repo:seed-[0-9a-f]{12}$/);
    // Both tags stay on the same repository (scoped push credentials).
    expect(String(secondRef).split(":")[0]).toBe(
      "registry.gitlab.com/group/repo",
    );
  });

  test("failed registry check degrades to build + push, never a silent skip", async () => {
    const baseUrl = healthyGateway();
    // Unsupported docker (`manifest` unknown) exits non-zero like an
    // absent tag — the seed must still build.
    dockerBehavior = (argv) => (argv[1] === "manifest" ? 125 : 0);
    const cwd = await withWorkspace(SEEDED_INPUTS_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(dockerCalls).toEqual([
      ["docker", "manifest", "inspect", SEED_REF],
      ["docker", "build", "-f", "Dockerfile.seed", "-t", SEED_REF, "."],
      ["docker", "push", SEED_REF],
      ["docker", "build", "-f", "Dockerfile", "-t", APP_REF, "."],
      ["docker", "push", APP_REF],
    ]);
    expect(stdout).not.toContain(`seed image reused: ${SEED_REF}`);
    expect(captured[0]?.body).toMatchObject({ seed_image: SEED_REF });
  });

  test("unreadable seed input fails before any docker work or deploy", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(
      `slug: myapp
seed:
  dockerfile: Dockerfile.seed
  inputs:
    - Dockerfile.seed
    - missing-entrypoint.sh
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`,
      { "Dockerfile.seed": SEED_DOCKERFILE },
    );
    const code = await runCli(
      ["ci", "preview"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "seed input not readable: missing-entrypoint.sh",
    ]);
    // The seed ensures before the app builds, so bad inputs fail with no
    // docker work at all and nothing deploys.
    expect(dockerCalls).toEqual([]);
    expect(captured).toEqual([]);
  });

  test("--reseed passes through to the deploy body", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(SEEDED_YAML, {
      "Dockerfile.seed": SEED_DOCKERFILE,
    });
    const code = await runCli(
      ["ci", "preview", "--reseed"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      app_image: APP_REF,
      seed_image: COMMIT_SEED_REF,
      reseed: true,
    });
  });

  test("--reseed without a seed block fails before building", async () => {
    const baseUrl = healthyGateway();
    const cwd = await withWorkspace(MINIMAL_YAML);
    const code = await runCli(
      ["ci", "preview", "--reseed"],
      deps({
        cwd,
        env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t", ...GITLAB_MR_ENV },
        readTextFile: readRealFile,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "--reseed requires a seed block in .sprout.yaml",
    ]);
    expect(dockerCalls).toEqual([]);
    expect(captured).toEqual([]);
  });
});
