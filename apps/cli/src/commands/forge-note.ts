import type { CliDeps, CliIo } from "../context.ts";
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
}): string {
  const lines = [
    SPROUT_NOTE_MARKER,
    "🌱 **Sprout preview ready**",
    "",
    `- Preview: ${input.previewUrl}`,
  ];
  const short = shortSha(input.sha);
  if (short) lines.push(`- Commit: \`${short}\``);
  lines.push("- Health: healthy");
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
  /** Which header carries the token — set by which env var won. */
  tokenHeader: "JOB-TOKEN" | "PRIVATE-TOKEN";
};

type GithubTarget = {
  forge: "github";
  base: string;
  repoPath: string;
  prId: number;
  token: string;
};

type ForgeTarget = GitlabTarget | GithubTarget;

/**
 * Explicit skip/target outcome: no forge token is a skip (local runs),
 * never a null smuggled inside the success type.
 */
export type ForgeTargetResolution =
  | { skipped: true }
  | { skipped: false; target: ForgeTarget };

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
 * Forge target from the already-resolved CI identity plus CI env. Switches
 * on `identity.forge` — the discriminant `requireCiSource` already proved —
 * never re-guesses the forge from the pipeline source.
 *
 * GitLab needs `CI_PROJECT_ID` (numeric, no encoding pitfalls) or
 * `CI_PROJECT_PATH`; there is no host-guessing fallback. GitHub prefers
 * `GITHUB_REPOSITORY` and falls back to the canonical repo id. Missing forge
 * token → skipped (no warning): local runs without a job token are not
 * failures.
 */
export function resolveForgeTarget(
  env: NodeJS.ProcessEnv,
  identity: CiIdentity,
): Result<ForgeTargetResolution> {
  if (identity.forge === "gitlab") {
    const jobToken = env.CI_JOB_TOKEN?.trim();
    const pat = env.GITLAB_TOKEN?.trim();
    const token = jobToken || pat || "";
    if (!token) return { ok: true, value: { skipped: true } };
    const base = stripTrailingSlash(
      env.CI_API_V4_URL?.trim() || "https://gitlab.com/api/v4",
    );
    const projectId = env.CI_PROJECT_ID?.trim();
    const projectPath = env.CI_PROJECT_PATH?.trim();
    let project: string | null = null;
    if (projectId) {
      project = projectId;
    } else if (projectPath) {
      project = encodeURIComponent(projectPath);
    } else {
      return {
        ok: false,
        error:
          "cannot derive GitLab project path (set CI_PROJECT_ID or CI_PROJECT_PATH)",
      };
    }
    return {
      ok: true,
      value: {
        skipped: false,
        target: {
          forge: "gitlab",
          base,
          project,
          iid: identity.prId,
          token,
          tokenHeader: jobToken ? "JOB-TOKEN" : "PRIVATE-TOKEN",
        },
      },
    };
  }

  const token = env.GITHUB_TOKEN?.trim() || "";
  if (!token) return { ok: true, value: { skipped: true } };
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
    value: {
      skipped: false,
      target: { forge: "github", base, repoPath, prId: identity.prId, token },
    },
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

/**
 * One forge request: network errors and non-2xx (with the forge's error
 * body, never the token) are errors. `op` names the operation for messages
 * (e.g. "GitLab notes list").
 */
async function forgeRequest(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  op: string,
  url: string,
  init: RequestInit,
): Promise<Result<Response>> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${op} failed: ${detail}` };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    return { ok: false, error: `${res.status} ${body}` };
  }
  return { ok: true, value: res };
}

async function parseNotesJson(
  op: string,
  res: Response,
): Promise<Result<ForgeNote[]>> {
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
    return { ok: false, error: `${op} returned invalid JSON` };
  }
}

/** Forge-specific request shape over one shared upsert (no parallel stacks). */
type ForgeAdapter = {
  listOp: string;
  writeOp: string;
  /** List URL without the `page` param (already carries `per_page`). */
  listBaseUrl: string;
  listHeaders: Record<string, string>;
  writeUrl: (existingId: number | null) => string;
  writeMethod: (existingId: number | null) => "POST" | "PUT" | "PATCH";
  writeHeaders: Record<string, string>;
  /**
   * Forge-specific pagination policy: GitLab signals via `x-next-page`,
   * GitHub via `Link: rel="next"`. A short page ends the walk; a full page
   * with no headers still advances (page-loop fallback, bounded by the cap).
   */
  hasMorePages: (headers: Headers, pageLength: number) => boolean;
};

function adapterForTarget(target: ForgeTarget): ForgeAdapter {
  if (target.forge === "gitlab") {
    const auth = { [target.tokenHeader]: target.token };
    const collection =
      `${target.base}/projects/${target.project}` +
      `/merge_requests/${target.iid}/notes`;
    return {
      listOp: "GitLab notes list",
      writeOp: "GitLab note write",
      listBaseUrl: `${collection}?per_page=${NOTES_PER_PAGE}`,
      listHeaders: { ...auth },
      writeUrl: (existingId) =>
        existingId === null ? collection : `${collection}/${existingId}`,
      writeMethod: (existingId) => (existingId === null ? "POST" : "PUT"),
      writeHeaders: { "Content-Type": "application/json", ...auth },
      hasMorePages: (headers, pageLength) => {
        if (pageLength < NOTES_PER_PAGE) return false;
        const next = headers.get("x-next-page");
        if (next === null) return true;
        const trimmed = next.trim();
        return trimmed !== "" && trimmed !== "0";
      },
    };
  }
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const collection =
    `${target.base}/repos/${target.repoPath}/issues/${target.prId}/comments`;
  return {
    listOp: "GitHub comments list",
    writeOp: "GitHub comment write",
    listBaseUrl: `${collection}?per_page=${NOTES_PER_PAGE}`,
    listHeaders: { ...headers },
    writeUrl: (existingId) =>
      existingId === null
        ? collection
        : `${target.base}/repos/${target.repoPath}/comments/${existingId}`,
    writeMethod: (existingId) => (existingId === null ? "POST" : "PATCH"),
    writeHeaders: { "Content-Type": "application/json", ...headers },
    hasMorePages: (headers, pageLength) => {
      if (pageLength < NOTES_PER_PAGE) return false;
      const link = headers.get("link");
      if (link === null) return true;
      return linkHeaderHasNext(link);
    },
  };
}

const NOTES_PER_PAGE = 100;
/** Cap on list pages: 1000 notes is far past any real MR thread. */
const MAX_NOTE_PAGES = 10;

function linkHeaderHasNext(link: string | null): boolean {
  if (!link) return false;
  return link.split(",").some((part) => /rel\s*=\s*"next"/.test(part));
}

/**
 * The sprout note's id, or null when no page carries the hidden marker.
 * Stops at the first page containing the marker so a busy MR never loads
 * the whole thread; a full last page without pagination headers still
 * advances (page-loop fallback) up to the page cap.
 */
async function findMarkedNoteId(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  adapter: ForgeAdapter,
): Promise<Result<number | null>> {
  for (let page = 1; page <= MAX_NOTE_PAGES; page++) {
    const res = await forgeRequest(
      doFetch,
      adapter.listOp,
      `${adapter.listBaseUrl}&page=${page}`,
      { method: "GET", headers: adapter.listHeaders },
    );
    if (!res.ok) return res;
    const parsed = await parseNotesJson(adapter.listOp, res.value);
    if (!parsed.ok) return parsed;
    const marked = parsed.value.find((n) =>
      n.body.includes(SPROUT_NOTE_MARKER),
    );
    if (marked) return { ok: true, value: marked.id };
    if (!adapter.hasMorePages(res.value.headers, parsed.value.length)) {
      return { ok: true, value: null };
    }
  }
  return { ok: true, value: null };
}

async function writeNote(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  adapter: ForgeAdapter,
  existingId: number | null,
  body: string,
): Promise<Result<void>> {
  const res = await forgeRequest(doFetch, adapter.writeOp, adapter.writeUrl(existingId), {
    method: adapter.writeMethod(existingId),
    headers: adapter.writeHeaders,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) return res;
  return { ok: true, value: undefined };
}

/**
 * Upsert one sprout note on the MR: create it when no note carries the
 * hidden marker, otherwise edit the existing one in place. Skip (no forge
 * token on local runs) is success; hard misconfiguration and forge
 * rejections are errors carrying the forge's error body. Never includes the
 * token in any message.
 */
export async function upsertForgeNote(
  deps: CliDeps,
  identity: CiIdentity,
  body: string,
): Promise<Result<void>> {
  const resolved = resolveForgeTarget(deps.env, identity);
  if (!resolved.ok) return resolved;
  if (resolved.value.skipped) return { ok: true, value: undefined };

  const doFetch = fetchFn(deps);
  const adapter = adapterForTarget(resolved.value.target);
  const existing = await findMarkedNoteId(doFetch, adapter);
  if (!existing.ok) return existing;
  return writeNote(doFetch, adapter, existing.value, body);
}

/** Preview success → create-or-update the MR note (non-fatal on failure). */
export async function publishPreviewNote(
  deps: CliDeps,
  identity: CiIdentity,
  previewUrl: string,
): Promise<Result<void>> {
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
): Promise<Result<void>> {
  const sha = resolveCommitSha(deps.env);
  return upsertForgeNote(
    deps,
    identity,
    buildTeardownNote({ prId: identity.prId, sha }),
  );
}

/**
 * Non-fatal forge-note policy in one place: gateway success owns the exit
 * code, note failures only warn (with the forge's error body, never the
 * token).
 */
export function warnForgeNote(io: CliIo, result: Result<void>): void {
  if (!result.ok) io.stderr(`warning: MR note update failed: ${result.error}`);
}
