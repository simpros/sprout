import { describe, expect, test } from "bun:test";
import type { CliContext } from "../context.ts";
import {
  ensureSeedImage,
  readSeedContents,
  resolveCommitSeedImageRef,
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

describe("resolveCommitSeedImageRef", () => {
  test("derives the commit-scoped tag suffix", () => {
    expect(
      resolveCommitSeedImageRef("registry.example.com/group/app:abc123"),
    ).toEqual({
      ok: true,
      value: "registry.example.com/group/app:abc123-seed",
    });
  });

  test("refuses a ref without a tag", () => {
    expect(resolveCommitSeedImageRef("registry/app").ok).toBe(false);
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

const files = (entries: Record<string, string>) => async (
  path: string,
): Promise<string | null> => {
  const name = path.split("/").at(-1)!;
  return entries[name] ?? null;
};

describe("readSeedContents", () => {
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

  test("the seed Dockerfile is always required", async () => {
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

  test("the Dockerfile is folded into explicit inputs once", async () => {
    const result = await readSeedContents(
      {
        dockerfile: "Dockerfile.seed",
        inputs: ["Dockerfile.seed", "entrypoint.sh"],
      },
      "/repo",
      files({ "Dockerfile.seed": "FROM x\n", "entrypoint.sh": "#!/bin/sh\n" }),
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { path: "Dockerfile.seed", content: "FROM x\n" },
        { path: "entrypoint.sh", content: "#!/bin/sh\n" },
      ],
    });
  });
});

describe("ensureSeedImage", () => {
  const SEED_FILES = { "Dockerfile.seed": "FROM x\n" };

  function fakeCtx(opts: {
    files?: Record<string, string>;
    manifestExit?: number;
  }): { ctx: CliContext; calls: string[][]; stdout: string[] } {
    const calls: string[][] = [];
    const stdout: string[] = [];
    const ctx = {
      deps: {
        env: {},
        cwd: "/repo",
        readTextFile: files(opts.files ?? SEED_FILES),
        getGitRemoteUrl: () => null,
        createClient: () => {
          throw new Error("unused");
        },
        runCommand: async (argv: string[]) => {
          calls.push(argv);
          if (argv[1] === "manifest") {
            return { exitCode: opts.manifestExit ?? 1 };
          }
          return { exitCode: 0 };
        },
        io: {
          stdout: (line: string) => stdout.push(line),
          stderr: () => {},
        },
      },
      client: {},
    } as unknown as CliContext;
    return { ctx, calls, stdout };
  }

  const APP_REF = "registry.example.com/group/app:abc123";

  test("without inputs always builds + pushes the commit-scoped tag", async () => {
    // Even when the registry probe would succeed, the commit path never
    // inspects — reuse is opt-in on explicit inputs.
    const { ctx, calls, stdout } = fakeCtx({ manifestExit: 0 });
    const result = await ensureSeedImage(
      ctx,
      { dockerfile: "Dockerfile.seed" },
      APP_REF,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        ref: "registry.example.com/group/app:abc123-seed",
        reused: false,
      },
    });
    expect(calls).toEqual([
      ["docker", "build", "-f", "Dockerfile.seed", "-t", "registry.example.com/group/app:abc123-seed", "."],
      ["docker", "push", "registry.example.com/group/app:abc123-seed"],
    ]);
    expect(stdout).toEqual([]);
  });

  test("with inputs reuses the content-addressed tag on probe hit", async () => {
    const { ctx, calls, stdout } = fakeCtx({ manifestExit: 0 });
    const result = await ensureSeedImage(
      ctx,
      { dockerfile: "Dockerfile.seed", inputs: ["Dockerfile.seed"] },
      APP_REF,
    );
    const ref = `registry.example.com/group/app:seed-${shortSeedHash([
      { path: "Dockerfile.seed", content: "FROM x\n" },
    ])}`;
    expect(result).toEqual({ ok: true, value: { ref, reused: true } });
    expect(calls).toEqual([["docker", "manifest", "inspect", ref]]);
    expect(stdout).toEqual([`seed image reused: ${ref}`]);
  });

  test("with inputs builds + pushes on probe miss", async () => {
    const { ctx, calls, stdout } = fakeCtx({ manifestExit: 1 });
    const result = await ensureSeedImage(
      ctx,
      { dockerfile: "Dockerfile.seed", inputs: ["Dockerfile.seed"] },
      APP_REF,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(false);
    expect(calls).toEqual([
      ["docker", "manifest", "inspect", result.value.ref],
      ["docker", "build", "-f", "Dockerfile.seed", "-t", result.value.ref, "."],
      ["docker", "push", result.value.ref],
    ]);
    expect(stdout).toEqual([]);
  });

  test("with inputs fails before docker on unreadable entries", async () => {
    const { ctx, calls } = fakeCtx({ files: SEED_FILES });
    const result = await ensureSeedImage(
      ctx,
      { dockerfile: "Dockerfile.seed", inputs: ["missing.sh"] },
      APP_REF,
    );
    expect(result).toEqual({
      ok: false,
      error: "seed input not readable: missing.sh",
    });
    expect(calls).toEqual([]);
  });
});
