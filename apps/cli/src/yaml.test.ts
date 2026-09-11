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
      error: "preview.app_env.PORT must be a string",
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
});
