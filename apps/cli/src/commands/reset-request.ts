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

/** Single fence-aware walk; the only place the toggle lives. */
function walkLines(
  body: string,
  visit: (line: string, visible: boolean) => void,
): void {
  let inFence: Fence | null = null;
  for (const line of body.split("\n")) {
    const tracked = trackFence(inFence, line);
    inFence = tracked.state;
    visit(line, !tracked.isFence && inFence === null);
  }
}

/** Lines outside fenced code blocks; fence delimiters excluded. */
function visibleLines(body: string): string[] {
  const out: string[] = [];
  walkLines(body, (line, visible) => {
    if (visible) out.push(line);
  });
  return out;
}

/** Rewrite visible lines; fences and hidden lines pass through untouched. */
function rewriteVisibleLines(
  body: string,
  fn: (line: string) => string,
): string | null {
  let changed = false;
  const out: string[] = [];
  walkLines(body, (line, visible) => {
    if (!visible) {
      out.push(line);
      return;
    }
    const next = fn(line);
    if (next !== line) changed = true;
    out.push(next);
  });
  return changed ? out.join("\n") : null;
}

/** Drop fenced code blocks so ticks/markers in examples never fire. */
export function stripFencedCodeBlocks(body: string): string {
  return visibleLines(body).join("\n");
}

/** One fence-aware pass over visible lines; the only place the ticked-box regex lives. */
function scanResetRequest(
  body: string | null | undefined,
): { marker: string | null; ticked: boolean } {
  if (!body) return { marker: null, ticked: false };
  let marker: string | null = null;
  let ticked = false;
  const markerRe = new RegExp(MARKER_PATTERN, "g");
  walkLines(body, (line, visible) => {
    if (!visible) return;
    for (const match of line.matchAll(markerRe)) {
      const token = parseResetMarkerToken(match[1] ?? "");
      if (token) marker = token;
    }
    if (TICKED_BOX_RE.test(line)) ticked = true;
  });
  return { marker, ticked };
}

/** Flip ticked reset boxes back to unticked, preserving the marker. */
export function untickResetBox(body: string): string | null {
  return rewriteVisibleLines(body, (line) => {
    const box = ANY_BOX_RE.exec(line);
    if (box && (box[2] === "x" || box[2] === "X")) {
      return `${box[1]} ${box[3]}`;
    }
    return line;
  });
}

function isTruncatedDescription(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Truncation triage; the single owner of the ticked-box-without-marker rule. */
export type ResetOutcome =
  | { kind: "reset"; marker: string }
  | { kind: "truncated-unreadable" }
  | { kind: "truncated-none" }
  | { kind: "none" };

export function classifyResetRequest(raw: ResetRequestBody): ResetOutcome {
  const scanned = scanResetRequest(raw.body);
  if (scanned.marker && scanned.ticked)
    return { kind: "reset", marker: scanned.marker };
  if (!raw.truncated) return { kind: "none" };
  return scanned.ticked
    ? { kind: "truncated-unreadable" }
    : { kind: "truncated-none" };
}

export function truncatedResetWarning(): string {
  return (
    "GitLab MR description is truncated — reset request not readable, skipping"
  );
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

/** Kind-to-severity mapping for truncated bodies; the rest of the policy. */
export function truncationNotice(
  outcome: ResetOutcome,
): { level: "warning" | "error"; message: string } | null {
  if (outcome.kind === "truncated-none")
    return { level: "warning", message: truncatedResetWarning() };
  if (outcome.kind === "truncated-unreadable")
    return { level: "error", message: truncatedDescriptionError() };
  return null;
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

/** Raw MR/PR body text from CI env, plus whether the GitLab prefix was truncated. */
export type ResetRequestBody = {
  body: string | null;
  truncated: boolean;
};

export async function readResetRequestBody(
  deps: CliDeps,
  forge: "gitlab" | "github",
): Promise<Result<ResetRequestBody>> {
  if (forge === "gitlab") {
    return {
      ok: true,
      value: {
        body: deps.env.CI_MERGE_REQUEST_DESCRIPTION ?? null,
        truncated: isTruncatedDescription(deps.env),
      },
    };
  }
  const event = await loadEventPayload(deps);
  if (!event.ok) return event;
  return { ok: true, value: { body: readGithubBody(event.value), truncated: false } };
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

/**
 * Exactly-once bookkeeping shared by `ci preview` and `ci reset`: record
 * the marker, then best-effort untick the PR body with a warning.
 */
export async function markResetRequestHandled(
  deps: CliDeps,
  client: ApiClient,
  identity: CiIdentity,
  rawBody: string | null,
  marker: string,
): Promise<Result<void>> {
  const marked = await recordHandledMarker(client, identity, marker);
  if (!marked.ok) return marked;
  if (!rawBody) return { ok: true, value: undefined };
  // Lazy import: forge-note statically imports this module for untickResetBox.
  const { untickGithubResetBox } = await import("./forge-note.ts");
  const unticked = await untickGithubResetBox(deps, identity, rawBody);
  if (!unticked.ok) {
    deps.io.stderr(`warning: ${unticked.error}`);
  }
  return { ok: true, value: undefined };
}
