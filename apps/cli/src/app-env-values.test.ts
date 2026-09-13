import { describe, expect, test } from "bun:test";
import { expandAppEnvValue, resolveAppEnvValues } from "./app-env-values.ts";

const ctx = {
  hostname: "pr-42.myapp.preview.example.com",
  prId: 42,
  commitSha: "abc123def",
  repo: "https://github.com/org/repo",
  deployToken: "test-token",
};

describe("resolveAppEnvValues", () => {
  test("string templates pass through unexpanded; required keys collected", () => {
    expect(
      resolveAppEnvValues(
        {
          BETTER_AUTH_URL: "https://{hostname}",
          LABEL: "pr-{pr_id}@{commit_sha}",
          STATIC: "info",
          STRIPE_API_KEY: { required: true },
        },
        ctx,
      ),
    ).toEqual({
      ok: true,
      value: {
        values: {
          BETTER_AUTH_URL: "https://{hostname}",
          LABEL: "pr-{pr_id}@{commit_sha}",
          STATIC: "info",
        },
        requiredKeys: ["STRIPE_API_KEY"],
      },
    });
  });

  test("undefined / empty → no values, no required", () => {
    expect(resolveAppEnvValues(undefined, ctx)).toEqual({
      ok: true,
      value: { values: undefined, requiredKeys: [] },
    });
    expect(resolveAppEnvValues({}, ctx)).toEqual({
      ok: true,
      value: { values: undefined, requiredKeys: [] },
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
        values: {
          BETTER_AUTH_SECRET: "anVkFMualWiVildhvR9ixQ2bSJXuAZO6m13Hj1y1cfU",
        },
        requiredKeys: [],
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
    expect(a.value.values!.SECRET_A).not.toEqual(b.value.values!.SECRET_B);
    expect(a.value.values!.SECRET_A).not.toEqual(otherPr.value.values!.SECRET_A);
  });

  test("missing deploy token for generate names the key", () => {
    expect(
      resolveAppEnvValues(
        { BETTER_AUTH_SECRET: { generate: "stable_per_pr" } },
        { ...ctx, deployToken: undefined },
      ),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.BETTER_AUTH_SECRET: SPROUT_TOKEN required for generate: stable_per_pr",
    });
  });

  test("only required entries → no values, keys listed", () => {
    expect(
      resolveAppEnvValues({ STRIPE_API_KEY: { required: true } }, ctx),
    ).toEqual({
      ok: true,
      value: { values: undefined, requiredKeys: ["STRIPE_API_KEY"] },
    });
  });

  test("required keys preserve declaration order", () => {
    const result = resolveAppEnvValues(
      {
        A: "x",
        B: { required: true },
        C: { generate: "stable_per_pr" },
        D: { required: true },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiredKeys).toEqual(["B", "D"]);
    expect(result.value.values?.A).toBe("x");
    expect(result.value.values?.C).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("expandAppEnvValue", () => {
  test("expands known placeholders", () => {
    expect(expandAppEnvValue("https://{hostname}/p{pr_id}", ctx)).toEqual({
      ok: true,
      value: "https://pr-42.myapp.preview.example.com/p42",
    });
  });

  test("returns a bare reason with no key prefix", () => {
    expect(expandAppEnvValue("https://{host}", ctx)).toEqual({
      ok: false,
      error: "unknown placeholder {host}",
    });
  });

  test("missing commit_sha when placeholder used", () => {
    expect(
      expandAppEnvValue("sha-{commit_sha}", { ...ctx, commitSha: undefined }),
    ).toEqual({
      ok: false,
      error: "{commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA",
    });
  });
});
