import { describe, expect, test } from "bun:test";
import { parseLabelMap } from "./labels.ts";
import { copyServiceExtras, type ServiceFields } from "./services.ts";

describe("parseLabelMap", () => {
  test("absent or empty map means no labels", () => {
    expect(parseLabelMap(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseLabelMap({})).toEqual({ ok: true, value: undefined });
  });

  test("passes traefik and non-traefik keys through verbatim", () => {
    expect(
      parseLabelMap({
        "traefik.docker.network": "traefik",
        "traefik.http.routers.api-pr.middlewares": "my-sso@file",
        "com.example.backup": "true",
      }),
    ).toEqual({
      ok: true,
      value: {
        "traefik.docker.network": "traefik",
        "traefik.http.routers.api-pr.middlewares": "my-sso@file",
        "com.example.backup": "true",
      },
    });
  });

  test("rejects non-mappings", () => {
    for (const raw of ["a=b", ["a=b"], 42, null]) {
      expect(parseLabelMap(raw)).toEqual({
        ok: false,
        issue: { code: "not_a_mapping" },
      });
    }
  });

  test("rejects blank and malformed keys", () => {
    expect(parseLabelMap({ "  ": "x" })).toEqual({
      ok: false,
      issue: { code: "empty_key" },
    });
    for (const key of ["bad key", "bad!key", "traefik.enable="]) {
      expect(parseLabelMap({ [key]: "x" })).toEqual({
        ok: false,
        issue: { code: "invalid_key", key },
      });
    }
  });

  test("rejects non-string values", () => {
    expect(parseLabelMap({ "com.example.backup": true })).toEqual({
      ok: false,
      issue: { code: "invalid_value", key: "com.example.backup" },
    });
  });

  test("rejects empty values", () => {
    for (const value of ["", "   "]) {
      expect(parseLabelMap({ "com.example.backup": value })).toEqual({
        ok: false,
        issue: { code: "empty_value", key: "com.example.backup" },
      });
    }
  });
});

describe("copyServiceExtras labels", () => {
  test("copies and clones labels", () => {
    const src: ServiceFields = { labels: { A: "1" } };
    const dst: ServiceFields = {};
    copyServiceExtras(src, dst);
    expect(dst).toEqual({ labels: { A: "1" } });
    src.labels!.A = "mutated";
    expect(dst.labels).toEqual({ A: "1" });
  });
});
