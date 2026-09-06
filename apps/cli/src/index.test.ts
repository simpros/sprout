import { describe, expect, test } from "bun:test";
import { resolveGatewayUrl } from "./index";

describe("resolveGatewayUrl", () => {
  test("prefers SPROUT_URL", () => {
    expect(
      resolveGatewayUrl({
        SPROUT_URL: " https://sprout.example ",
        PB_GATEWAY_URL: "http://old",
      }),
    ).toBe("https://sprout.example");
  });

  test("falls back to PB_GATEWAY_URL", () => {
    expect(resolveGatewayUrl({ PB_GATEWAY_URL: " http://legacy " })).toBe(
      "http://legacy",
    );
  });

  test("defaults to local gateway", () => {
    expect(resolveGatewayUrl({})).toBe("http://127.0.0.1:7331");
  });
});
