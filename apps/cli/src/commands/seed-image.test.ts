import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEED_LOCKFILES,
  defaultSeedInputs,
  readSeedContents,
  resolveSeedImageRef,
  SEED_TAG_HASH_LEN,
  shortSeedHash,
} from "./seed-image.ts";

describe("shortSeedHash", () => {
  test("is stable and short", () => {
    const entries = [{ path: "Dockerfile.seed", content: "FROM x\n" }];
    expect(shortSeedHash(entries)).toBe(shortSeedHash(entries));
    expect(shortSeedHash(entries)).toMatch(/^[0-9a-f]+$/);
    expect(shortSeedHash(entries)).toHaveLength(SEED_TAG_HASH_LEN);
  });

  test("is order-independent but path-sensitive", () => {
    const a = [
      { path: "a", content: "1" },
      { path: "b", content: "2" },
    ];
    const reordered = [
      { path: "b", content: "2" },
      { path: "a", content: "1" },
    ];
    expect(shortSeedHash(reordered)).toBe(shortSeedHash(a));
    expect(
      shortSeedHash([
        { path: "a", content: "2" },
        { path: "b", content: "1" },
      ]),
    ).not.toBe(shortSeedHash(a));
    // Same bytes under a different path re-tag.
    expect(shortSeedHash([{ path: "renamed", content: "1" }])).not.toBe(
      shortSeedHash([{ path: "a", content: "1" }]),
    );
  });
});

describe("defaultSeedInputs", () => {
  test("starts with the seed Dockerfile plus lockfile candidates", () => {
    const inputs = defaultSeedInputs("Dockerfile.seed");
    expect(inputs[0]).toBe("Dockerfile.seed");
    for (const lockfile of DEFAULT_SEED_LOCKFILES) {
      expect(inputs).toContain(lockfile);
    }
    expect(inputs).toContain("package.json");
  });
});

describe("resolveSeedImageRef", () => {
  test("keeps the same-repository tag-suffix shape", () => {
    expect(
      resolveSeedImageRef("registry.example.com/group/app:sha", "0123456789ab"),
    ).toEqual({
      ok: true,
      value: "registry.example.com/group/app:seed-0123456789ab",
    });
  });
});

describe("readSeedContents", () => {
  const files = (entries: Record<string, string>) => async (
    path: string,
  ): Promise<string | null> => {
    const name = path.split("/").at(-1)!;
    return entries[name] ?? null;
  };

  test("explicit inputs are all required", async () => {
    const result = await readSeedContents(
      { dockerfile: "Dockerfile.seed", inputs: ["Dockerfile.seed", "seed.ts"] },
      "/repo",
      files({ "Dockerfile.seed": "FROM x\n" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "seed input not readable: seed.ts",
    });
  });

  test("explicit inputs hash when all present", async () => {
    const result = await readSeedContents(
      { dockerfile: "Dockerfile.seed", inputs: ["Dockerfile.seed"] },
      "/repo",
      files({ "Dockerfile.seed": "FROM x\n" }),
    );
    expect(result).toEqual({
      ok: true,
      value: [{ path: "Dockerfile.seed", content: "FROM x\n" }],
    });
  });

  test("defaults skip absent lockfiles but require the Dockerfile", async () => {
    const hashed = await readSeedContents(
      { dockerfile: "Dockerfile.seed" },
      "/repo",
      files({
        "Dockerfile.seed": "FROM x\n",
        "package.json": "{}\n",
      }),
    );
    expect(hashed).toEqual({
      ok: true,
      value: [
        { path: "Dockerfile.seed", content: "FROM x\n" },
        { path: "package.json", content: "{}\n" },
      ],
    });

    const missing = await readSeedContents(
      { dockerfile: "Dockerfile.seed" },
      "/repo",
      files({}),
    );
    expect(missing).toEqual({
      ok: false,
      error: "seed input not readable: Dockerfile.seed",
    });
  });
});
