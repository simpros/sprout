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
});
