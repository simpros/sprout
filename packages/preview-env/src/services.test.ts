import { describe, expect, test } from "bun:test";
import {
  copyServiceExtras,
  isServicePort,
  parseServiceEnvMap,
  SERVICE_PORT_MAX,
  SERVICE_PORT_MIN,
  type ServiceFields,
} from "./services.ts";

describe("isServicePort", () => {
  test("accepts the full 1-65535 range", () => {
    expect(isServicePort(SERVICE_PORT_MIN)).toBe(true);
    expect(isServicePort(8080)).toBe(true);
    expect(isServicePort(SERVICE_PORT_MAX)).toBe(true);
  });

  test("rejects non-integers and out-of-range values", () => {
    for (const raw of [0, 65536, 3.5, NaN, "8080", null, undefined, true]) {
      expect(isServicePort(raw)).toBe(false);
    }
  });
});

describe("parseServiceEnvMap", () => {
  test("absent or empty map means no env", () => {
    expect(parseServiceEnvMap(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseServiceEnvMap({})).toEqual({ ok: true, value: undefined });
  });

  test("accepts string values including empty strings", () => {
    expect(parseServiceEnvMap({ PORT: "8080", EMPTY: "" })).toEqual({
      ok: true,
      value: { PORT: "8080", EMPTY: "" },
    });
  });

  test("rejects non-mappings", () => {
    for (const raw of ["PORT=1", ["PORT=1"], 42, null]) {
      expect(parseServiceEnvMap(raw)).toEqual({
        ok: false,
        issue: { code: "not_a_mapping" },
      });
    }
  });

  test("rejects blank and invalid keys", () => {
    expect(parseServiceEnvMap({ "  ": "x" })).toEqual({
      ok: false,
      issue: { code: "empty_key" },
    });
    expect(parseServiceEnvMap({ "bad-name": "x" })).toEqual({
      ok: false,
      issue: { code: "invalid_key", key: "bad-name" },
    });
  });

  test("rejects non-string values", () => {
    expect(parseServiceEnvMap({ PORT: 8080 })).toEqual({
      ok: false,
      issue: { code: "invalid_value", key: "PORT" },
    });
  });
});

describe("copyServiceExtras", () => {
  test("copies port and clones env", () => {
    const src: ServiceFields = { port: 8080, env: { A: "1" } };
    const dst: ServiceFields = {};
    copyServiceExtras(src, dst);
    expect(dst).toEqual({ port: 8080, env: { A: "1" } });
    src.env!.A = "mutated";
    expect(dst.env).toEqual({ A: "1" });
  });

  test("leaves absent fields unset", () => {
    const dst: ServiceFields = { port: 1, env: { K: "v" } };
    copyServiceExtras({}, dst);
    expect(dst).toEqual({ port: 1, env: { K: "v" } });
  });
});
