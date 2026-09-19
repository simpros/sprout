import { parseResetMarkerToken } from "@sprout/preview-db";
import type { ApiClient } from "@sprout/api-client";
import { loadEventPayload, type CliDeps } from "../context.ts";
import { readEden } from "../eden.ts";
import type { Result } from "../result.ts";
import type { CiIdentity } from "./ci-identity.ts";

/** MR/PR-body reset contract: tick the box and rotate the marker token. */
export const RESET_BOX_SNIPPET =
  "- [ ] Sprout: reset preview <!-- sprout-reset: TOKEN -->";

const MARKER_PATTERN = "<!--\\s*sprout-reset\\s*:\\s*([^<>]*?)\\s*-->";
const TICKED_BOX_RE =
  /^\s*[-*]\s*\[(x|X)\]\s*Sprout:\s*reset\s+preview\b/i;
const ANY_BOX_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*Sprout:\s*reset\s+preview\b.*)$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

type Fence = "`" | "~";

function fenceChar(line: string): Fence | null {
  const fence = FENCE_RE.exec(line);
  if (!fence) return null;
  return fence[1]![0] === "`" ? "`" : "~";
}

/** Single fence tracker: returns the updated state and whether the line opens/closes a fence. */
function trackFence(inFence: Fence | null, line: string): {
  state: Fence | null;
  isFence: boolean;
} {
  const char = fenceChar(line);
  if (!char) return { state: inFence, isFence: false };
  if (inFence === null) return { state: char, isFence: true };
  if (inFence === char) return { state: null, isFence: true };
  return { state: inFence, isFence: true };
}

/** Lines outside fenced code blocks; fence delimiters excluded. */
function visibleLines(body: string): string[] {
  const out: string[] = [];
  let inFence: Fence | null = null;
  for (const line of body.split("\n")) {
    const tracked = trackFence(inFence, line);
    inFence = tracked.state;
    if (tracked.isFence || inFence !== null) continue;
    out.push(line);
  }
  return out;
}

/** Drop fenced code blocks so ticks/markers in examples never fire. */
export function stripFencedCodeBlocks(body: string): string {
  return visibleLines(body).join("\n");
}

/**
 * Parse an MR/PR body. Returns the reset token when a ticked box and a
 * non-empty marker are both present outside fenced code blocks.
 */
export function parseResetRequest(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const visible = visibleLines(body);
  let marker: string | null = null;
  const markerRe = new RegExp(MARKER_PATTERN, "g");
  for (const line of visible) {
    for (const match of line.matchAll(markerRe)) {
      const token = parseResetMarkerToken(match[1] ?? "");
      if (token) marker = token;
    }
  }
  if (!marker) return null;
  for (const line of visible) {
    if (TICKED_BOX_RE.test(line)) return marker;
  }
  return null;
}

/** Flip ticked reset boxes back to unticked, preserving the marker. */
export function untickResetBox(body: string): string | null {
  const lines = body.split("\n");
  let inFence: Fence | null = null;
  let changed = false;
  const next = lines.map((line) => {
    const tracked = trackFence(inFence, line);
    inFence = tracked.state;
    if (tracked.isFence || inFence !== null) return line;
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

type PreviewMarkerFields = {
  reset_request_marker: string | null;
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
  return { ok: true, value: result.data.reset_request_marker };
}

/** Record a marker as handled; the row exists — deploy just wrote it. */
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
