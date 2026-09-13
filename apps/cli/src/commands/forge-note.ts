import type { CliDeps } from "../context.ts";
import { resolveCommitSha } from "../identity.ts";
import type { Result } from "../result.ts";
import type { CiIdentity } from "./ci-identity.ts";

/**
 * Hidden marker keying one sprout note per MR. Re-runs edit the existing
 * note instead of stacking comments (#121).
 */
export const SPROUT_NOTE_MARKER = "<!-- sprout-preview-note -->";

function fetchFn(deps: CliDeps): (url: string, init?: RequestInit) => Promise<Response> {
  return deps.fetchFn ?? globalThis.fetch;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function shortSha(sha: string | undefined): string | undefined {
  const trimmed = sha?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 7);
}

/** Markdown for a live preview: URL, short SHA, health, logs hint. */
export function buildPreviewNote(input: {
  previewUrl: string;
  sha?: string;
  prId: number;
  health?: string;
}): string {
  const lines = [
    SPROUT_NOTE_MARKER,
    "🌱 **Sprout preview ready**",
    "",
    `- Preview: ${input.previewUrl}`,
  ];
  const short = shortSha(input.sha);
  if (short) lines.push(`- Commit: \`${short}\``);
  lines.push(`- Health: ${input.health ?? "healthy"}`);
  lines.push("");
  lines.push(`Logs: \`sprout ci logs ${input.prId}\``);
  return lines.join("\n");
}

/** Markdown replacing the same note after teardown: removed, not deleted. */
export function buildTeardownNote(input: {
  prId: number;
  sha?: string;
}): string {
  const lines = [
    SPROUT_NOTE_MARKER,
    "🌱 **Sprout preview removed**",
    "",
    "The preview for this merge request was removed.",
  ];
  const short = shortSha(input.sha);
  if (short) lines.push(`\nLast commit: \`${short}\``);
  lines.push("");
  lines.push(`\`sprout ci logs ${input.prId}\` will report no preview until the next deploy.`);
  return lines.join("\n");
}

type GitlabTarget = {
  forge: "gitlab";
  base: string;
  project: string;
  iid: number;
  token: string;
};

type GithubTarget = {
  forge: "github";
  base: string;
  repoPath: string;
  prId: number;
  token: string;
};

type ForgeTarget = GitlabTarget | GithubTarget;

function repoPathFromCanonical(repo: string, host: string): string | null {
  try {
    const url = new URL(repo);
    if (url.hostname !== host) return null;
    return url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Forge target from the already-resolved CI identity plus CI env.
 * GitLab prefers `CI_PROJECT_ID` (numeric, no encoding pitfalls) and falls
 * back to the URL-encoded project path (`CI_PROJECT_PATH` or the canonical
 * repo id). GitHub prefers `GITHUB_REPOSITORY` and falls back to the
 * canonical repo id. Missing forge token → skipped (no warning): local runs
 * without a job token are not failures.
 */
export function resolveForgeTarget(
  env: NodeJS.ProcessEnv,
  identity: CiIdentity,
): Result<ForgeTarget | null> {
  if (identity.pipelineSource === "merge_request_event") {
    const jobToken = env.CI_JOB_TOKEN?.trim();
    const pat = env.GITLAB_TOKEN?.trim();
    const token = jobToken || pat || "";
    if (!token) return { ok: true, value: null };
    const base = stripTrailingSlash(
      env.CI_API_V4_URL?.trim() || "https://gitlab.com/api/v4",
    );
    const projectId = env.CI_PROJECT_ID?.trim();
    let project: string | null = null;
    if (projectId) {
      project = projectId;
    } else {
      const path =
        env.CI_PROJECT_PATH?.trim() ||
        repoPathFromCanonical(identity.repo, "gitlab.com") ||
        repoPathFromCanonical(identity.repo, new URL(base).hostname || "");
      if (!path) {
        return {
          ok: false,
          error: "cannot derive GitLab project path (set CI_PROJECT_ID)",
        };
      }
      project = encodeURIComponent(path);
    }
    return {
      ok: true,
      value: { forge: "gitlab", base, project, iid: identity.prId, token },
    };
  }

  const token = env.GITHUB_TOKEN?.trim() || "";
  if (!token) return { ok: true, value: null };
  const base = stripTrailingSlash(
    env.GITHUB_API_URL?.trim() || "https://api.github.com",
  );
  const repoPath =
    env.GITHUB_REPOSITORY?.trim() ||
    repoPathFromCanonical(identity.repo, "github.com");
  if (!repoPath || !repoPath.includes("/")) {
    return {
      ok: false,
      error: "cannot derive GitHub repository (set GITHUB_REPOSITORY)",
    };
  }
  return {
    ok: true,
    value: { forge: "github", base, repoPath, prId: identity.prId, token },
  };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, 500) : res.statusText || "unknown error";
  } catch {
    return res.statusText || "unknown error";
  }
}

type ForgeNote = { id: number; body: string };

async function listGitlabNotes(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GitlabTarget,
): Promise<Result<ForgeNote[]>> {
  const url =
    `${target.base}/projects/${target.project}` +
    `/merge_requests/${target.iid}/notes?per_page=100`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: {
        "JOB-TOKEN": target.token,
        "PRIVATE-TOKEN": target.token,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GitLab notes list failed: ${detail}` };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    return { ok: false, error: `${res.status} ${body}` };
  }
  try {
    const data = (await res.json()) as Array<{ id?: unknown; body?: unknown }>;
    if (!Array.isArray(data)) return { ok: true, value: [] };
    return {
      ok: true,
      value: data.flatMap((n) =>
        typeof n.id === "number" && typeof n.body === "string"
          ? [{ id: n.id, body: n.body }]
          : [],
      ),
    };
  } catch {
    return { ok: false, error: "GitLab notes list returned invalid JSON" };
  }
}

async function writeGitlabNote(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GitlabTarget,
  existingId: number | null,
  body: string,
): Promise<Result<void>> {
  const headers = {
    "Content-Type": "application/json",
    "JOB-TOKEN": target.token,
    "PRIVATE-TOKEN": target.token,
  };
  const url = existingId === null
    ? `${target.base}/projects/${target.project}/merge_requests/${target.iid}/notes`
    : `${target.base}/projects/${target.project}/merge_requests/${target.iid}/notes/${existingId}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: existingId === null ? "POST" : "PUT",
      headers,
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GitLab note write failed: ${detail}` };
  }
  if (!res.ok) {
    const errBody = await readErrorBody(res);
    return { ok: false, error: `${res.status} ${errBody}` };
  }
  return { ok: true, value: undefined };
}

async function listGithubComments(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
): Promise<Result<ForgeNote[]>> {
  const url =
    `${target.base}/repos/${target.repoPath}` +
    `/issues/${target.prId}/comments?per_page=100`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GitHub comments list failed: ${detail}` };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    return { ok: false, error: `${res.status} ${body}` };
  }
  try {
    const data = (await res.json()) as Array<{ id?: unknown; body?: unknown }>;
    if (!Array.isArray(data)) return { ok: true, value: [] };
    return {
      ok: true,
      value: data.flatMap((c) =>
        typeof c.id === "number" && typeof c.body === "string"
          ? [{ id: c.id, body: c.body }]
          : [],
      ),
    };
  } catch {
    return { ok: false, error: "GitHub comments list returned invalid JSON" };
  }
}

async function writeGithubComment(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  existingId: number | null,
  body: string,
): Promise<Result<void>> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const url = existingId === null
    ? `${target.base}/repos/${target.repoPath}/issues/${target.prId}/comments`
    : `${target.base}/repos/${target.repoPath}/comments/${existingId}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: existingId === null ? "POST" : "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GitHub comment write failed: ${detail}` };
  }
  if (!res.ok) {
    const errBody = await readErrorBody(res);
    return { ok: false, error: `${res.status} ${errBody}` };
  }
  return { ok: true, value: undefined };
}

/**
 * Upsert one sprout note on the MR: create it when no note carries the
 * hidden marker, otherwise edit the existing one in place. Returns
 * `skipped: true` when no forge token is configured (local runs); hard
 * misconfiguration and forge rejections are errors carrying the forge's
 * error body. Never includes the token in any message.
 */
export async function upsertForgeNote(
  deps: CliDeps,
  identity: CiIdentity,
  body: string,
): Promise<Result<{ skipped: boolean }>> {
  const target = resolveForgeTarget(deps.env, identity);
  if (!target.ok) return target;
  if (target.value === null) return { ok: true, value: { skipped: true } };

  const doFetch = fetchFn(deps);
  if (target.value.forge === "gitlab") {
    const listed = await listGitlabNotes(doFetch, target.value);
    if (!listed.ok) return listed;
    const existing = listed.value.find((n) => n.body.includes(SPROUT_NOTE_MARKER));
    const written = await writeGitlabNote(
      doFetch,
      target.value,
      existing?.id ?? null,
      body,
    );
    if (!written.ok) return written;
    return { ok: true, value: { skipped: false } };
  }

  const listed = await listGithubComments(doFetch, target.value);
  if (!listed.ok) return listed;
  const existing = listed.value.find((c) => c.body.includes(SPROUT_NOTE_MARKER));
  const written = await writeGithubComment(
    doFetch,
    target.value,
    existing?.id ?? null,
    body,
  );
  if (!written.ok) return written;
  return { ok: true, value: { skipped: false } };
}

/** Preview success → create-or-update the MR note (non-fatal on failure). */
export async function publishPreviewNote(
  deps: CliDeps,
  identity: CiIdentity,
  previewUrl: string,
): Promise<Result<{ skipped: boolean }>> {
  const sha = resolveCommitSha(deps.env);
  return upsertForgeNote(
    deps,
    identity,
    buildPreviewNote({ previewUrl, sha, prId: identity.prId }),
  );
}

/** Teardown success → rewrite the same note as removed (non-fatal). */
export async function publishTeardownNote(
  deps: CliDeps,
  identity: CiIdentity,
): Promise<Result<{ skipped: boolean }>> {
  const sha = resolveCommitSha(deps.env);
  return upsertForgeNote(
    deps,
    identity,
    buildTeardownNote({ prId: identity.prId, sha }),
  );
}
