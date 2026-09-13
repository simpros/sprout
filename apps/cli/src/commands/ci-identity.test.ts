import { describe, expect, test } from "bun:test";
import {
  requireCiSource,
  resolveCiIdentity,
  resolveCiPreviewIdentity,
  resolveImageRef,
} from "./ci-identity.ts";
import type { CliDeps } from "../context.ts";

function deps(
  env: NodeJS.ProcessEnv,
  overrides: Partial<CliDeps> = {},
): CliDeps {
  return {
    env,
    cwd: "/work",
    readTextFile: async () =>
      `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\n`,
    getGitRemoteUrl: () => null,
    createClient: () => ({}) as ReturnType<CliDeps["createClient"]>,
    io: { stdout: () => {}, stderr: () => {} },
    ...overrides,
  };
}

describe("requireCiSource", () => {
  test("accepts GitLab merge_request_event", () => {
    expect(
      requireCiSource({ CI_PIPELINE_SOURCE: "merge_request_event" }),
    ).toEqual({
      ok: true,
      value: { forge: "gitlab", pipelineSource: "merge_request_event" },
    });
  });

  test("accepts GitHub pull_request even when GitLab source is absent", () => {
    expect(requireCiSource({ GITHUB_EVENT_NAME: "pull_request" })).toEqual({
      ok: true,
      value: { forge: "github", pipelineSource: "pull_request" },
    });
  });

  test("prefers GitLab MR source over stray GitHub push event", () => {
    expect(
      requireCiSource({
        CI_PIPELINE_SOURCE: "merge_request_event",
        GITHUB_EVENT_NAME: "push",
      }),
    ).toEqual({
      ok: true,
      value: { forge: "gitlab", pipelineSource: "merge_request_event" },
    });
  });

  test("prefers GitHub pull_request over stray GitLab push source", () => {
    expect(
      requireCiSource({
        CI_PIPELINE_SOURCE: "push",
        GITHUB_EVENT_NAME: "pull_request",
      }),
    ).toEqual({
      ok: true,
      value: { forge: "github", pipelineSource: "pull_request" },
    });
  });

  test("refuses ambiguous pipeline claiming both forges", () => {
    expect(
      requireCiSource({
        CI_PIPELINE_SOURCE: "merge_request_event",
        GITHUB_EVENT_NAME: "pull_request",
      }),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses ambiguous pipeline (CI_PIPELINE_SOURCE=merge_request_event and GITHUB_EVENT_NAME=pull_request); run in a single merge-request or pull-request pipeline",
    });
  });

  test("refuses GitLab non-MR pipeline", () => {
    expect(requireCiSource({ CI_PIPELINE_SOURCE: "push" })).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=push); run from a merge-request pipeline",
    });
  });

  test("refuses GitHub non-pull_request event", () => {
    expect(requireCiSource({ GITHUB_EVENT_NAME: "push" })).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (GITHUB_EVENT_NAME=push); run from a pull_request workflow",
    });
  });

  test("refuses when neither pipeline source var is set", () => {
    expect(
      requireCiSource({ CI_MERGE_REQUEST_IID: "9", GITHUB_REF: "refs/pull/1/merge" }),
    ).toEqual({
      ok: false,
      error:
        "sprout ci must run in a merge-request or pull-request pipeline (set CI_PIPELINE_SOURCE=merge_request_event or GITHUB_EVENT_NAME=pull_request)",
    });
  });
});

describe("resolveImageRef", () => {
  test("builds registry:sha from the locked GitLab SHA", () => {
    expect(
      resolveImageRef(
        { CI_REGISTRY_IMAGE: "registry.example/app" },
        { forge: "gitlab", commitSha: "abc" },
      ),
    ).toEqual({ ok: true, value: "registry.example/app:abc" });
  });

  test("builds registry:sha from the locked GitHub SHA", () => {
    expect(
      resolveImageRef(
        { CI_REGISTRY_IMAGE: "ghcr.io/org/repo" },
        { forge: "github", commitSha: "def" },
      ),
    ).toEqual({ ok: true, value: "ghcr.io/org/repo:def" });
  });

  test("uses the locked SHA even when the other forge's var is set", () => {
    expect(
      resolveImageRef(
        {
          CI_REGISTRY_IMAGE: "registry.example/app",
          CI_COMMIT_SHA: "aaa",
          GITHUB_SHA: "bbb",
        },
        { forge: "gitlab", commitSha: "aaa" },
      ),
    ).toEqual({ ok: true, value: "registry.example/app:aaa" });
  });

  test("gitlab forge names CI_COMMIT_SHA when the locked SHA is missing", () => {
    expect(
      resolveImageRef(
        {
          CI_REGISTRY_IMAGE: "registry.example/app",
          GITHUB_SHA: "def",
        },
        { forge: "gitlab", commitSha: undefined },
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA)",
    });
  });

  test("github forge names GITHUB_SHA when the locked SHA is missing", () => {
    expect(
      resolveImageRef(
        {
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
          CI_COMMIT_SHA: "abc",
        },
        { forge: "github", commitSha: undefined },
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive image ref (set CI_REGISTRY_IMAGE and GITHUB_SHA)",
    });
  });

  test("errors when registry missing", () => {
    expect(
      resolveImageRef(
        { CI_COMMIT_SHA: "abc" },
        { forge: "gitlab", commitSha: "abc" },
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA)",
    });
  });
});

describe("resolveCiIdentity", () => {
  test("resolves GitLab merge-request pipeline without image or yaml", async () => {
    expect(
      await resolveCiIdentity(
        deps(
          {
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_MERGE_REQUEST_IID: "17",
            CI_PIPELINE_SOURCE: "merge_request_event",
          },
          { readTextFile: async () => null },
        ),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "gitlab",
        repo: "https://gitlab.com/group/repo",
        prId: 17,
        pipelineSource: "merge_request_event",
        commitSha: undefined,
      },
    });
  });

  test("resolves GitHub pull_request workflow without image or yaml", async () => {
    expect(
      await resolveCiIdentity(
        deps(
          {
            GITHUB_REPOSITORY: "org/repo",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_REF: "refs/pull/42/merge",
          },
          { readTextFile: async () => null },
        ),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "github",
        repo: "https://github.com/org/repo",
        prId: 42,
        pipelineSource: "pull_request",
        commitSha: undefined,
      },
    });
  });

  test("resolves GitHub pull_request_target workflow", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_REF: "refs/pull/8/merge",
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "github",
        repo: "https://github.com/org/repo",
        prId: 8,
        pipelineSource: "pull_request_target",
        commitSha: undefined,
      },
    });
  });

  test("succeeds for GitLab MR despite stray GITHUB_EVENT_NAME=push", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "3",
          CI_PIPELINE_SOURCE: "merge_request_event",
          GITHUB_EVENT_NAME: "push",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        forge: "gitlab",
        pipelineSource: "merge_request_event",
        prId: 3,
      },
    });
  });

  test("succeeds for GitHub PR despite stray CI_PIPELINE_SOURCE=push", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          CI_PIPELINE_SOURCE: "push",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        forge: "github",
        pipelineSource: "pull_request",
        prId: 42,
      },
    });
  });

  test("refuses ambiguous pipeline claiming both forges", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "3",
          CI_PIPELINE_SOURCE: "merge_request_event",
          GITHUB_EVENT_NAME: "pull_request",
        }),
      ),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses ambiguous pipeline (CI_PIPELINE_SOURCE=merge_request_event and GITHUB_EVENT_NAME=pull_request); run in a single merge-request or pull-request pipeline",
    });
  });

  test("ignores GITHUB_REF when forge is GitLab", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_PIPELINE_SOURCE: "merge_request_event",
          GITHUB_REF: "refs/pull/99/merge",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive pr id (CI_MERGE_REQUEST_IID)",
    });
  });

  test("ignores unreadable GITHUB_EVENT_PATH when forge is GitLab", async () => {
    expect(
      await resolveCiIdentity(
        deps(
          {
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_MERGE_REQUEST_IID: "5",
            CI_PIPELINE_SOURCE: "merge_request_event",
            GITHUB_EVENT_PATH: "/missing/event.json",
          },
          { readTextFile: async () => null },
        ),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "gitlab",
        repo: "https://gitlab.com/group/repo",
        prId: 5,
        pipelineSource: "merge_request_event",
        commitSha: undefined,
      },
    });
  });

  test("ignores CI_MERGE_REQUEST_IID when forge is GitHub", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request",
          CI_MERGE_REQUEST_IID: "17",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive pr id (GitHub pull_request event or GITHUB_REF)",
    });
  });

  test("errors when pipeline source vars absent even if MR iid set", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
        }),
      ),
    ).toEqual({
      ok: false,
      error:
        "sprout ci must run in a merge-request or pull-request pipeline (set CI_PIPELINE_SOURCE=merge_request_event or GITHUB_EVENT_NAME=pull_request)",
    });
  });

  test("errors on GitLab detached non-MR pipeline", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_PIPELINE_SOURCE: "push",
        }),
      ),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=push); run from a merge-request pipeline",
    });
  });

  test("errors on GitHub non-pull_request event", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "push",
        }),
      ),
    ).toEqual({
      ok: false,
      error:
        "sprout ci refuses detached/non-MR pipelines (GITHUB_EVENT_NAME=push); run from a pull_request workflow",
    });
  });

  test("locks the forge-scoped SHA and ignores the other forge's var", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "17",
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_COMMIT_SHA: "aaa",
          GITHUB_SHA: "bbb",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { forge: "gitlab", commitSha: "aaa" },
    });
    expect(
      await resolveCiIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          CI_COMMIT_SHA: "aaa",
          GITHUB_SHA: "bbb",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { forge: "github", commitSha: "bbb" },
    });
  });

  test("leaves commitSha undefined when the forge's var is missing", async () => {
    expect(
      await resolveCiIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "17",
          CI_PIPELINE_SOURCE: "merge_request_event",
          GITHUB_SHA: "bbb",
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { forge: "gitlab", commitSha: undefined },
    });
  });
});

describe("resolveCiPreviewIdentity", () => {
  test("adds image ref and hostname for GitLab MR", async () => {
    expect(
      await resolveCiPreviewIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "17",
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
          CI_COMMIT_SHA: "abc123",
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "gitlab",
        repo: "https://gitlab.com/group/repo",
        prId: 17,
        pipelineSource: "merge_request_event",
        commitSha: "abc123",
        imageRef: "registry.gitlab.com/group/repo:abc123",
        hostname: "pr-17.example.com",
      },
    });
  });

  test("adds image ref and hostname for GitHub pull_request", async () => {
    expect(
      await resolveCiPreviewIdentity(
        deps({
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/42/merge",
          CI_REGISTRY_IMAGE: "ghcr.io/org/repo",
          GITHUB_SHA: "def456",
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        forge: "github",
        repo: "https://github.com/org/repo",
        prId: 42,
        pipelineSource: "pull_request",
        commitSha: "def456",
        imageRef: "ghcr.io/org/repo:def456",
        hostname: "pr-42.example.com",
      },
    });
  });

  test("errors when image ref cannot be derived", async () => {
    expect(
      await resolveCiPreviewIdentity(
        deps({
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_PIPELINE_SOURCE: "merge_request_event",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA)",
    });
  });

  test("errors when .sprout.yaml is missing", async () => {
    expect(
      await resolveCiPreviewIdentity(
        deps(
          {
            CI_PROJECT_URL: "https://gitlab.com/group/repo",
            CI_MERGE_REQUEST_IID: "9",
            CI_PIPELINE_SOURCE: "merge_request_event",
            CI_REGISTRY_IMAGE: "registry.gitlab.com/group/repo",
            CI_COMMIT_SHA: "abc",
          },
          { readTextFile: async () => null },
        ),
      ),
    ).toEqual({
      ok: false,
      error: "missing /work/.sprout.yaml",
    });
  });
});
