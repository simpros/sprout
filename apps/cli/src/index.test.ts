import { describe, expect, test } from "bun:test";
import { resolveGatewayUrl } from "./index.ts";

describe("resolveGatewayUrl", () => {
  test("reads SPROUT_URL", () => {
    expect(resolveGatewayUrl({ SPROUT_URL: " https://sprout.example " })).toBe(
      "https://sprout.example",
    );
  });

  test("defaults to local gateway", () => {
    expect(resolveGatewayUrl({})).toBe("http://127.0.0.1:7331");
  });
});
