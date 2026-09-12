import { describe, expect, test } from "bun:test";
import { resolveAppEnvValues } from "./app-env-values.ts";

const ctx = {
  hostname: "pr-42.myapp.preview.example.com",
  prId: 42,
  commitSha: "abc123def",
  repo: "https://github.com/org/repo",
  deployToken: "test-token",
};

describe("resolveAppEnvValues", () => {
  test("string-only map passes through with placeholder expansion", () => {
    expect(
      resolveAppEnvValues(
        {
          BETTER_AUTH_URL: "https://{hostname}",
          LABEL: "pr-{pr_id}@{commit_sha}",
          STATIC: "info",
        },
        ctx,
      ),
    ).toEqual({
      ok: true,
      value: {
        BETTER_AUTH_URL: "https://pr-42.myapp.preview.example.com",
        LABEL: "pr-42@abc123def",
        STATIC: "info",
      },
    });
  });

  test("undefined / empty → undefined", () => {
    expect(resolveAppEnvValues(undefined, ctx)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(resolveAppEnvValues({}, ctx)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("stable_per_pr is deterministic HMAC base64url", () => {
    const first = resolveAppEnvValues(
      { BETTER_AUTH_SECRET: { generate: "stable_per_pr" } },
      ctx,
    );
    const second = resolveAppEnvValues(
      { BETTER_AUTH_SECRET: { generate: "stable_per_pr" } },
      ctx,
    );
    expect(first).toEqual({
      ok: true,
      // HMAC-SHA256("test-token", "sprout-stable-per-pr:https://github.com/org/repo:42:BETTER_AUTH_SECRET") base64url
      value: {
        BETTER_AUTH_SECRET: "anVkFMualWiVildhvR9ixQ2bSJXuAZO6m13Hj1y1cfU",
      },
    });
    expect(second).toEqual(first);
  });

  test("stable_per_pr differs by env key and pr id", () => {
    const a = resolveAppEnvValues(
      { SECRET_A: { generate: "stable_per_pr" } },
      ctx,
    );
    const b = resolveAppEnvValues(
      { SECRET_B: { generate: "stable_per_pr" } },
      ctx,
    );
    const otherPr = resolveAppEnvValues(
      { SECRET_A: { generate: "stable_per_pr" } },
      { ...ctx, prId: 99 },
    );
    expect(a.ok && b.ok && otherPr.ok).toBe(true);
    if (!a.ok || !b.ok || !otherPr.ok) return;
    expect(a.value!.SECRET_A).not.toEqual(b.value!.SECRET_B);
    expect(a.value!.SECRET_A).not.toEqual(otherPr.value!.SECRET_A);
  });

  test("unknown placeholder names the key", () => {
    expect(
      resolveAppEnvValues({ ORIGIN: "https://{host}" }, ctx),
    ).toEqual({
      ok: false,
      error: "preview.app_env.ORIGIN: unknown placeholder {host}",
    });
  });

  test("missing commit_sha when placeholder used names the key", () => {
    expect(
      resolveAppEnvValues(
        { REF: "sha-{commit_sha}" },
        { ...ctx, commitSha: undefined },
      ),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.REF: {commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA",
    });
  });

  test("missing deploy token for generate names the key", () => {
    expect(
      resolveAppEnvValues(
        { BETTER_AUTH_SECRET: { generate: "stable_per_pr" } },
        { ...ctx, deployToken: "" },
      ),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.BETTER_AUTH_SECRET: SPROUT_TOKEN required for generate: stable_per_pr",
    });
  });
});
