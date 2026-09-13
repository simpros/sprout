import { describe, expect, test } from "bun:test";
import {
  normalizeGitRemoteUrl,
  resolveCanonicalRepoId,
  resolveCommitSha,
  resolveCommitShaAny,
  resolvePrId,
  resolvePrIdAny,
  resolveRepoForForge,
} from "./identity.ts";

describe("normalizeGitRemoteUrl", () => {
  test("normalizes github ssh and https remotes", () => {
    expect(normalizeGitRemoteUrl("git@github.com:org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(normalizeGitRemoteUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(normalizeGitRemoteUrl("https://github.com/org/repo")).toBe(
      "https://github.com/org/repo",
    );
  });

  test("normalizes gitlab ssh remotes", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:group/repo.git")).toBe(
      "https://gitlab.com/group/repo",
    );
  });
});

describe("resolveCanonicalRepoId", () => {
  test("prefers GITHUB_REPOSITORY", () => {
    expect(
      resolveCanonicalRepoId({
        env: { GITHUB_REPOSITORY: "org/repo" },
      }),
    ).toEqual({ ok: true, value: "https://github.com/org/repo" });
  });

  test("uses GitLab CI_PROJECT_URL", () => {
    expect(
      resolveCanonicalRepoId({
        env: { CI_PROJECT_URL: "https://gitlab.com/group/repo" },
      }),
    ).toEqual({ ok: true, value: "https://gitlab.com/group/repo" });
  });

  test("falls back to git remote", () => {
    expect(
      resolveCanonicalRepoId({
        env: {},
        gitRemoteUrl: "git@github.com:org/repo.git",
      }),
    ).toEqual({ ok: true, value: "https://github.com/org/repo" });
  });

  test("errors when nothing available", () => {
    expect(resolveCanonicalRepoId({ env: {} })).toEqual({
      ok: false,
      error:
        "cannot derive canonical repo id (set GITHUB_REPOSITORY, CI_PROJECT_URL, or git remote)",
    });
  });
});

describe("resolveRepoForForge", () => {
  test("reads GitLab CI_PROJECT_URL only", () => {
    expect(
      resolveRepoForForge("gitlab", {
        CI_PROJECT_URL: "https://gitlab.com/group/repo.git",
        GITHUB_REPOSITORY: "org/ignored",
      }),
    ).toEqual({ ok: true, value: "https://gitlab.com/group/repo" });
  });

  test("reads GITHUB_REPOSITORY only", () => {
    expect(
      resolveRepoForForge("github", {
        GITHUB_REPOSITORY: "org/repo",
        CI_PROJECT_URL: "https://gitlab.com/ignored",
      }),
    ).toEqual({ ok: true, value: "https://github.com/org/repo" });
  });

  test("errors with forge-specific hint", () => {
    expect(resolveRepoForForge("gitlab", {})).toEqual({
      ok: false,
      error: "cannot derive canonical repo id (set CI_PROJECT_URL)",
    });
    expect(resolveRepoForForge("github", {})).toEqual({
      ok: false,
      error: "cannot derive canonical repo id (set GITHUB_REPOSITORY)",
    });
  });
});

describe("resolvePrId with strict forge", () => {
  test("github reads pull_request payload and GITHUB_REF", () => {
    expect(
      resolvePrId({ env: {}, eventPayload: { pull_request: { number: 42 } }, forge: "github" }),
    ).toEqual({ ok: true, value: 42 });
    expect(
      resolvePrId({ env: { GITHUB_REF: "refs/pull/99/merge" }, forge: "github" }),
    ).toEqual({ ok: true, value: 99 });
  });

  test("github ignores CI_MERGE_REQUEST_IID", () => {
    expect(
      resolvePrId({ env: { CI_MERGE_REQUEST_IID: "12" }, forge: "github" }),
    ).toEqual({
      ok: false,
      error: "cannot derive pr id (GitHub pull_request event or GITHUB_REF)",
    });
  });

  test("gitlab reads CI_MERGE_REQUEST_IID only", () => {
    expect(
      resolvePrId({
        env: {
          CI_MERGE_REQUEST_IID: "12",
          GITHUB_REF: "refs/pull/99/merge",
        },
        forge: "gitlab",
      }),
    ).toEqual({ ok: true, value: 12 });
  });

  test("gitlab ignores GITHUB_REF", () => {
    expect(
      resolvePrId({
        env: { GITHUB_REF: "refs/pull/99/merge" },
        forge: "gitlab",
      }),
    ).toEqual({
      ok: false,
      error: "cannot derive pr id (CI_MERGE_REQUEST_IID)",
    });
  });
});

describe("resolvePrIdAny (deploy path)", () => {
  test("reads GitHub pull request event payload", () => {
    expect(
      resolvePrIdAny({
        env: {},
        eventPayload: { pull_request: { number: 42 } },
      }),
    ).toEqual({ ok: true, value: 42 });
  });

  test("reads GitHub issue/PR number from event", () => {
    expect(
      resolvePrIdAny({
        env: {},
        eventPayload: { number: 7 },
      }),
    ).toEqual({ ok: true, value: 7 });
  });

  test("parses GITHUB_REF pull ref", () => {
    expect(
      resolvePrIdAny({
        env: { GITHUB_REF: "refs/pull/99/merge" },
      }),
    ).toEqual({ ok: true, value: 99 });
  });

  test("reads GitLab CI_MERGE_REQUEST_IID", () => {
    expect(
      resolvePrIdAny({
        env: { CI_MERGE_REQUEST_IID: "12" },
      }),
    ).toEqual({ ok: true, value: 12 });
  });

  test("prefers GitHub over GitLab when both present", () => {
    expect(
      resolvePrIdAny({
        env: {
          GITHUB_REF: "refs/pull/99/merge",
          CI_MERGE_REQUEST_IID: "12",
        },
      }),
    ).toEqual({ ok: true, value: 99 });
  });

  test("errors when missing", () => {
    expect(resolvePrIdAny({ env: {} })).toEqual({
      ok: false,
      error:
        "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
    });
  });
});

describe("resolveCommitShaAny", () => {
  test("reads GITHUB_SHA", () => {
    expect(resolveCommitShaAny({ GITHUB_SHA: "abc123" })).toBe("abc123");
  });

  test("reads CI_COMMIT_SHA when GITHUB_SHA absent", () => {
    expect(resolveCommitShaAny({ CI_COMMIT_SHA: "def456" })).toBe("def456");
  });

  test("prefers GITHUB_SHA over CI_COMMIT_SHA when forge unknown", () => {
    expect(
      resolveCommitShaAny({ GITHUB_SHA: "abc", CI_COMMIT_SHA: "def" }),
    ).toBe("abc");
  });

  test("returns undefined when neither is set", () => {
    expect(resolveCommitShaAny({})).toBeUndefined();
  });
});

describe("resolveCommitSha", () => {

  test("forge-scoped github ignores CI_COMMIT_SHA", () => {
    expect(
      resolveCommitSha({ GITHUB_SHA: "abc", CI_COMMIT_SHA: "def" }, "github"),
    ).toBe("abc");
    expect(resolveCommitSha({ CI_COMMIT_SHA: "def" }, "github")).toBeUndefined();
  });

  test("forge-scoped gitlab ignores GITHUB_SHA", () => {
    expect(
      resolveCommitSha({ GITHUB_SHA: "abc", CI_COMMIT_SHA: "def" }, "gitlab"),
    ).toBe("def");
    expect(resolveCommitSha({ GITHUB_SHA: "abc" }, "gitlab")).toBeUndefined();
  });
});
