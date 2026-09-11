import { describe, expect, test } from "bun:test";
import { mergeServices, parseServiceFlag } from "./services.ts";

describe("parseServiceFlag", () => {
  test("parses name=image", () => {
    expect(parseServiceFlag("api=ghcr.io/org/api:sha")).toEqual({
      ok: true,
      value: { name: "api", image: "ghcr.io/org/api:sha" },
    });
  });

  test("rejects invalid shapes", () => {
    expect(parseServiceFlag("api").ok).toBe(false);
    expect(parseServiceFlag("=image").ok).toBe(false);
    expect(parseServiceFlag("API=image").ok).toBe(false);
    expect(parseServiceFlag("api=").ok).toBe(false);
  });
});

describe("mergeServices", () => {
  test("merges yaml routing with CLI images", () => {
    expect(
      mergeServices(
        [
          {
            name: "api",
            hostname: "api-pr-{pr_id}.example.com",
          },
          { name: "worker" },
        ],
        ["api=ghcr.io/org/api:1", "worker=ghcr.io/org/worker:1"],
      ),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "api",
          image: "ghcr.io/org/api:1",
          hostname: "api-pr-{pr_id}.example.com",
        },
        { name: "worker", image: "ghcr.io/org/worker:1" },
      ],
    });
  });

  test("CLI-only services need no yaml", () => {
    expect(mergeServices(undefined, ["api=img:1"])).toEqual({
      ok: true,
      value: [{ name: "api", image: "img:1" }],
    });
  });

  test("fails when yaml service has no image after merge", () => {
    expect(mergeServices([{ name: "api" }], [])).toEqual({
      ok: false,
      error: "service api requires an image (--service api=<image>)",
    });
  });
});
