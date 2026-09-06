import { describe, expect, test } from "bun:test";
import {
  normalizeGitRemoteUrl,
  resolveCanonicalRepoId,
  resolvePrId,
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

describe("resolvePrId", () => {
  test("reads GitHub pull request event payload", () => {
    expect(
      resolvePrId({
        env: {},
        eventPayload: { pull_request: { number: 42 } },
      }),
    ).toEqual({ ok: true, value: 42 });
  });

  test("reads GitHub issue/PR number from event", () => {
    expect(
      resolvePrId({
        env: {},
        eventPayload: { number: 7 },
      }),
    ).toEqual({ ok: true, value: 7 });
  });

  test("parses GITHUB_REF pull ref", () => {
    expect(
      resolvePrId({
        env: { GITHUB_REF: "refs/pull/99/merge" },
      }),
    ).toEqual({ ok: true, value: 99 });
  });

  test("reads GitLab CI_MERGE_REQUEST_IID", () => {
    expect(
      resolvePrId({
        env: { CI_MERGE_REQUEST_IID: "12" },
      }),
    ).toEqual({ ok: true, value: 12 });
  });

  test("errors when missing", () => {
    expect(resolvePrId({ env: {} })).toEqual({
      ok: false,
      error:
        "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
    });
  });
});
