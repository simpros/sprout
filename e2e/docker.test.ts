import { describe, expect, test } from "bun:test";
import { envMap } from "./harness/docker.ts";

describe("envMap", () => {
  test("parses KEY=VALUE entries", () => {
    const map = envMap(["FOO=bar", "EMPTY=", "EQ=a=b"]);
    expect(map.get("FOO")).toBe("bar");
    expect(map.get("EMPTY")).toBe("");
    expect(map.get("EQ")).toBe("a=b");
  });

  test("throws on malformed entries", () => {
    expect(() => envMap(["NOEQUALS"])).toThrow(/malformed/);
    expect(() => envMap(["=novalue"])).toThrow(/malformed/);
  });
});
