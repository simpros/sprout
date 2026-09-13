import { describe, expect, test } from "bun:test";
import { parseSproutYaml } from "./yaml.ts";

describe("parseSproutYaml", () => {
  test("parses minimal config", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.myapp.preview.example.com" },
      },
    });
  });

  test("parses health block", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
        health: {
          path: "/health",
          interval: "2s",
          timeout: "120s",
          expect: 200,
        },
      },
    });
  });

  test("parses preview.env remap", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: DATABASE_HOST
    PGPORT: DATABASE_PORT
    PGUSER: DATABASE_USER
    PGPASSWORD: DATABASE_PASSWORD
    PGDATABASE: DATABASE_NAME
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          env: {
            PGHOST: "DATABASE_HOST",
            PGPORT: "DATABASE_PORT",
            PGUSER: "DATABASE_USER",
            PGPASSWORD: "DATABASE_PASSWORD",
            PGDATABASE: "DATABASE_NAME",
          },
        },
      },
    });
  });

  test("accepts identity and partial preview.env maps", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: PGHOST
    PGUSER: DATABASE_USER
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          env: {
            PGHOST: "PGHOST",
            PGUSER: "DATABASE_USER",
          },
        },
      },
    });
  });

  test("treats empty preview.env as absent", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env: {}
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
      },
    });
  });

  test("rejects unknown preview.env keys", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    DATABASE_URL: DATABASE_URL
`),
    ).toEqual({
      ok: false,
      error: "unknown key: preview.env.DATABASE_URL",
    });
  });

  test("rejects empty or invalid preview.env targets", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: ""
`),
    ).toEqual({
      ok: false,
      error: "preview.env.PGHOST is required",
    });
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: "   "
`),
    ).toEqual({
      ok: false,
      error: "preview.env.PGHOST is required",
    });
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: "bad-name"
`),
    ).toEqual({
      ok: false,
      error: "preview.env.PGHOST is invalid",
    });
  });

  test("rejects preview.env target collisions", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  env:
    PGHOST: DATABASE_HOST
    PGPORT: DATABASE_HOST
`),
    ).toEqual({
      ok: false,
      error: "preview.env: target collision: DATABASE_HOST",
    });
  });

  test("parses preview.app_env string map", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    BETTER_AUTH_URL: "https://pr-1.example.com"
    KIDO_APP_URL: "https://pr-1.example.com"
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          app_env: {
            BETTER_AUTH_URL: "https://pr-1.example.com",
            KIDO_APP_URL: "https://pr-1.example.com",
          },
        },
      },
    });
  });

  test("treats empty preview.app_env as absent", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env: {}
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
      },
    });
  });

  test("parses preview.app_env generate: stable_per_pr", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    BETTER_AUTH_URL: "https://{hostname}"
    BETTER_AUTH_SECRET:
      generate: stable_per_pr
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          app_env: {
            BETTER_AUTH_URL: "https://{hostname}",
            BETTER_AUTH_SECRET: { generate: "stable_per_pr" },
          },
        },
      },
    });
  });

  test("parses preview.app_env required: true", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    STRIPE_API_KEY:
      required: true
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          app_env: { STRIPE_API_KEY: { required: true } },
        },
      },
    });
  });

  test("rejects required: false", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    STRIPE_API_KEY:
      required: false
`),
    ).toEqual({
      ok: false,
      error: "preview.app_env.STRIPE_API_KEY: required must be true",
    });
  });

  test("rejects non-string preview.app_env values", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    PORT: 3000
`),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.PORT must be a string, { generate: stable_per_pr }, or { required: true }",
    });
  });

  test("rejects unknown generate kind", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    SECRET:
      generate: once
`),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.SECRET: unknown generate kind: once",
    });
  });

  test("rejects malformed generate object", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  app_env:
    SECRET:
      generate: stable_per_pr
      extra: 1
`),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.SECRET must be a string, { generate: stable_per_pr }, or { required: true }",
    });
  });

  test("rejects unknown top-level keys", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
commands:
  seed: ./seed.sh
`);
    expect(result).toEqual({
      ok: false,
      error: "unknown key: commands",
    });
  });

  test("rejects unknown preview keys", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  port: 8080
`);
    expect(result).toEqual({
      ok: false,
      error: "unknown key: preview.port",
    });
  });

  test("rejects unknown health keys", () => {
    const result = parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
  method: GET
`);
    expect(result).toEqual({
      ok: false,
      error: "unknown key: health.method",
    });
  });

  test("requires slug and preview.hostname", () => {
    expect(parseSproutYaml(`preview:\n  hostname: x`)).toEqual({
      ok: false,
      error: "slug is required",
    });
    expect(parseSproutYaml(`slug: myapp\npreview: {}`)).toEqual({
      ok: false,
      error: "preview.hostname is required",
    });
  });

  test("parses preview.services", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: api
      hostname: "api-pr-{pr_id}.example.com"
    - name: worker
      path: /internal
`),
    ).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: {
          hostname: "pr-{pr_id}.example.com",
          services: [
            {
              name: "api",
              hostname: "api-pr-{pr_id}.example.com",
            },
            { name: "worker", path: "/internal" },
          ],
        },
      },
    });
  });

  test("rejects invalid preview.services entries", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: API
`),
    ).toEqual({
      ok: false,
      error: "preview.services[0].name is invalid",
    });
  });

  test("rejects empty preview.services list", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services: []
`),
    ).toEqual({
      ok: false,
      error:
        "preview.services: empty list; omit the key to leave companions, or pass --clear-services",
    });
  });

  test("rejects hostname templates without {pr_id}", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-42.example.com"
`),
    ).toEqual({
      ok: false,
      error: "preview.hostname must contain {pr_id}",
    });
  });

  test("rejects hostname templates with scheme, path, or placeholders", () => {
    for (const hostname of [
      "https://pr-{pr_id}.example.com",
      "pr-{pr_id}.example.com/preview",
      "pr-{pr_id}.example.com:8080",
      "pr-{pr_id}-{sha}.example.com",
    ]) {
      const result = parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "${hostname}"\n`,
      );
      expect(result.ok).toBe(false);
    }
    expect(
      parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "https://pr-{pr_id}.example.com"\n`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("preview.hostname") });
  });

  test("rejects invalid service hostnames", () => {
    expect(
      parseSproutYaml(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: api
      image: api:1
      hostname: "https://api.example.com"
`),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("preview.services[0].hostname"),
    });
  });

  test("rejects malformed health durations, path, and expect", () => {
    const base = (health: string) =>
      parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nhealth:\n${health}`,
      );
    expect(base("  path: health\n  interval: 2s\n  timeout: 120s\n  expect: 200\n")).toEqual({
      ok: false,
      error: "health.path must start with /",
    });
    expect(base("  path: /health\n  interval: 2x\n  timeout: 120s\n  expect: 200\n")).toEqual({
      ok: false,
      error: "health.interval is invalid (expected Ns, e.g. 2s)",
    });
    expect(base("  path: /health\n  interval: 2s\n  timeout: 0s\n  expect: 200\n")).toEqual({
      ok: false,
      error: "health.timeout is invalid (expected Ns, e.g. 2s)",
    });
    expect(base("  path: /health\n  interval: 2s\n  timeout: 120s\n  expect: 99\n")).toEqual({
      ok: false,
      error: "health.expect must be a number between 100 and 599",
    });
  });

  test("parses build and seed dockerfile blocks", () => {
    const result = parseSproutYaml(`
slug: myapp
build:
  dockerfile: docker/Dockerfile
seed:
  dockerfile: Dockerfile.seed
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
        build: { dockerfile: "docker/Dockerfile" },
        seed: { dockerfile: "Dockerfile.seed" },
      },
    });
  });

  test("empty build and seed blocks take conventional defaults", () => {
    const result = parseSproutYaml(`
slug: myapp
build: {}
seed: {}
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
        build: { dockerfile: "Dockerfile" },
        seed: { dockerfile: "Dockerfile.seed" },
      },
    });
  });

  test("rejects malformed build and seed blocks", () => {
    const base = (extra: string) =>
      parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\n${extra}`,
      );
    expect(base("build: Dockerfile\n")).toEqual({
      ok: false,
      error: "build must be a mapping",
    });
    expect(base("seed:\n  dockerfile: ''\n")).toEqual({
      ok: false,
      error: "seed.dockerfile is required",
    });
    expect(base("seed:\n  dockerfile: Dockerfile.seed\n  bogus: 1\n")).toEqual({
      ok: false,
      error: "unknown key: seed.bogus",
    });
    expect(base("seed:\n  args: not-a-list\n")).toEqual({
      ok: false,
      error: "seed.args must be a list",
    });
    expect(base("seed:\n  args:\n    - ''\n")).toEqual({
      ok: false,
      error: "seed.args[0] is required",
    });
    expect(base("seed:\n  env:\n    SECRET:\n      generate: once\n")).toEqual({
      ok: false,
      error: "seed.env.SECRET: unknown generate kind: once",
    });
  });

  test("parses seed env and args", () => {
    const result = parseSproutYaml(`
slug: myapp
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
    SEED_URL: "https://{hostname}"
    SEED_SECRET:
      generate: stable_per_pr
    API_KEY:
      required: true
  args:
    - --reset
    - --fixtures=demo
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
        seed: {
          dockerfile: "Dockerfile.seed",
          env: {
            FIXTURE_SET: "demo",
            SEED_URL: "https://{hostname}",
            SEED_SECRET: { generate: "stable_per_pr" },
            API_KEY: { required: true },
          },
          args: ["--reset", "--fixtures=demo"],
        },
      },
    });
  });

  test("empty seed env and args are absent", () => {
    const result = parseSproutYaml(`
slug: myapp
seed:
  env: {}
  args: []
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    expect(result).toEqual({
      ok: true,
      value: {
        slug: "myapp",
        preview: { hostname: "pr-{pr_id}.example.com" },
        seed: { dockerfile: "Dockerfile.seed" },
      },
    });
  });
});
