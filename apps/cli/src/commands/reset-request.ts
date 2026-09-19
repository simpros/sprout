import type { ApiClient } from "@sprout/api-client";
import { loadEventPayload, type CliDeps } from "../context.ts";
import { readEden } from "../eden.ts";
import type { Result } from "../result.ts";
import type { CiIdentity } from "./ci-identity.ts";

/** MR/PR-body reset contract: tick the box and rotate the marker token. */
export const RESET_BOX_SNIPPET =
  "- [ ] Sprout: reset preview <!-- sprout-reset: TOKEN -->";

const MARKER_RE = /<!--\s*sprout-reset\s*:\s*([^<>]*?)\s*-->/g;
const TICKED_BOX_RE =
  /^\s*[-*]\s*\[(x|X)\]\s*Sprout:\s*reset\s+preview\b/i;
const ANY_BOX_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*Sprout:\s*reset\s+preview\b.*)$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function validMarkerToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || token.length > 256 || /[\r\n<>]/.test(token)) return null;
  return token;
}

/** Drop fenced code blocks so ticks/markers in examples never fire. */
export function stripFencedCodeBlocks(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inFence: "`" | "~" | null = null;
  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const char = fence[1][0] === "`" ? "`" : "~";
      if (inFence === null) {
        inFence = char;
      } else if (inFence === char) {
        inFence = null;
      }
      continue;
    }
    if (inFence !== null) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Parse an MR/PR body. Returns the reset token when a ticked box and a
 * non-empty marker are both present outside fenced code blocks.
 */
export function parseResetRequest(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const visible = stripFencedCodeBlocks(body);
  let marker: string | null = null;
  MARKER_RE.lastIndex = 0;
  for (const match of visible.matchAll(MARKER_RE)) {
    const token = validMarkerToken(match[1] ?? "");
    if (token) marker = token;
  }
  if (!marker) return null;
  for (const line of visible.split("\n")) {
    if (TICKED_BOX_RE.test(line)) return marker;
  }
  return null;
}

/** Flip ticked reset boxes back to unticked, preserving the marker. */
export function untickResetBox(body: string): string | null {
  const lines = body.split("\n");
  let inFence: "`" | "~" | null = null;
  let changed = false;
  const next = lines.map((line) => {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const char = fence[1][0] === "`" ? "`" : "~";
      if (inFence === null) {
        inFence = char;
      } else if (inFence === char) {
        inFence = null;
      }
      return line;
    }
    if (inFence !== null) return line;
    const box = ANY_BOX_RE.exec(line);
    if (box && (box[2] === "x" || box[2] === "X")) {
      changed = true;
      return `${box[1]} ${box[3]}`;
    }
    return line;
  });
  return changed ? next.join("\n") : null;
}

function isTruncated(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function truncatedDescriptionError(): string {
  return (
    "GitLab MR description is truncated " +
    "(CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED=true); move the " +
    "'- [ ] Sprout: reset preview' checkbox and the " +
    "'<!-- sprout-reset: <token> -->' marker into the first 2700 characters " +
    "so the reset request is visible"
  );
}

function readGithubBody(eventPayload: unknown): string | null {
  if (eventPayload && typeof eventPayload === "object") {
    const pr = (eventPayload as { pull_request?: unknown }).pull_request;
    if (pr && typeof pr === "object") {
      const body = (pr as { body?: unknown }).body;
      if (typeof body === "string") return body;
    }
  }
  return null;
}

/** Raw MR/PR body text from CI env; GitLab truncation is a hard error. */
export async function readResetRequestBody(
  deps: CliDeps,
  forge: "gitlab" | "github",
): Promise<Result<string | null>> {
  if (forge === "gitlab") {
    if (isTruncated(deps.env)) {
      return { ok: false, error: truncatedDescriptionError() };
    }
    return { ok: true, value: deps.env.CI_MERGE_REQUEST_DESCRIPTION ?? null };
  }
  const event = await loadEventPayload(deps);
  if (!event.ok) return event;
  return { ok: true, value: readGithubBody(event.value) };
}

/** Requested reset token, or null when no ticked box + marker is present. */
export async function resolveResetRequest(
  deps: CliDeps,
  forge: "gitlab" | "github",
): Promise<Result<string | null>> {
  const body = await readResetRequestBody(deps, forge);
  if (!body.ok) return body;
  return { ok: true, value: parseResetRequest(body.value) };
}

type PreviewMarkerFields = {
  reset_request_marker?: string | null;
};

/** Handled marker stored on the preview row; missing row reads as null. */
export async function fetchHandledMarker(
  client: ApiClient,
  identity: Pick<CiIdentity, "repo" | "prId">,
): Promise<Result<string | null>> {
  const response = await client.v1.preview.get({
    query: {
      canonical_repo_id: identity.repo,
      pr_id: String(identity.prId),
    },
  });
  const result = readEden<PreviewMarkerFields>(response);
  if (!result.ok) {
    if (result.status === 404) return { ok: true, value: null };
    return { ok: false, error: result.message };
  }
  return { ok: true, value: result.data.reset_request_marker ?? null };
}

/** Record a marker as handled; the row must exist (teardown preserves it). */
export async function recordHandledMarker(
  client: ApiClient,
  identity: Pick<CiIdentity, "repo" | "prId">,
  marker: string,
): Promise<Result<void>> {
  const response = await client.v1["reset-marker"].post({
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
    marker,
  });
  const result = readEden<unknown>(response);
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true, value: undefined };
}

/** Rewrite the GitHub PR body with the box unticked; no token means skip. */
export async function untickGithubResetBox(
  deps: CliDeps,
  identity: CiIdentity,
  body: string,
): Promise<Result<void>> {
  if (identity.forge !== "github") return { ok: true, value: undefined };
  const unticked = untickResetBox(body);
  if (!unticked) return { ok: true, value: undefined };
  const token = deps.env.GITHUB_TOKEN?.trim();
  if (!token) return { ok: true, value: undefined };
  const repoPath =
    deps.env.GITHUB_REPOSITORY?.trim() || null;
  if (!repoPath || !repoPath.includes("/")) {
    return {
      ok: false,
      error: "cannot derive GitHub repository (set GITHUB_REPOSITORY)",
    };
  }
  const base = (deps.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const doFetch = deps.fetchFn ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(
      `${base}/repos/${repoPath}/pulls/${identity.prId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: unticked }),
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GitHub PR body rewrite failed: ${detail}` };
  }
  if (!res.ok) {
    let detail = res.statusText || "unknown error";
    try {
      const text = (await res.text()).trim();
      if (text) detail = text.slice(0, 500);
    } catch {
    }
    return { ok: false, error: `GitHub PR body rewrite failed: ${res.status} ${detail}` };
  }
  return { ok: true, value: undefined };
}
