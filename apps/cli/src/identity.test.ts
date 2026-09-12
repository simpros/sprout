import { describe, expect, test } from "bun:test";
import {
  normalizeGitRemoteUrl,
  resolveCanonicalRepoId,
  resolveCiIdentity,
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

describe("resolveCiIdentity", () => {
  test("resolves GitLab merge-request pipeline", () => {
    expect(
      resolveCiIdentity({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "17",
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc123",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        repo: "https://gitlab.com/group/repo",
        prId: 17,
        pipelineSource: "merge_request_event",
        imageRef: "registry.gitlab.com/group/repo:abc123",
      },
    });
  });

  test("resolves GitHub pull_request workflow", () => {
    expect(
      resolveCiIdentity({
        env: {
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
          GITHUB_SHA: "def456",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        repo: "https://github.com/org/repo",
        prId: 42,
        pipelineSource: "pull_request",
        imageRef: "ghcr.io/org/repo:def456",
      },
    });
  });

  test("resolves GitHub pull_request_target workflow", () => {
    expect(
      resolveCiIdentity({
        env: {
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_REF: "refs/pull/8/merge",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
          GITHUB_SHA: "aa11bb",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        repo: "https://github.com/org/repo",
        prId: 8,
        pipelineSource: "pull_request_target",
        imageRef: "ghcr.io/org/repo:aa11bb",
      },
    });
  });

  test("errors when no MR/PR context", () => {
    expect(
      resolveCiIdentity({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc123",
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "sprout ci must run in a merge-request or pull-request pipeline (set CI_MERGE_REQUEST_IID or GitHub pull_request context)",
    });
  });

  test("errors on GitLab detached non-MR pipeline", () => {
    expect(
      resolveCiIdentity({
        env: {
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_PIPELINE_SOURCE: "push",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc123",
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=push); run from a merge-request pipeline",
    });
  });

  test("errors on GitHub non-pull_request event", () => {
    expect(
      resolveCiIdentity({
        env: {
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "push",
          GITHUB_SHA: "def456",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (GITHUB_EVENT_NAME=push); run from a pull_request workflow",
    });
  });
});
