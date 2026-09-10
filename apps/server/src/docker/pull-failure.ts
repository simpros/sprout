/** Classify Engine pull failures for API error codes + CLI-safe detail. */

export type PullFailureKind = "auth" | "other";

export type ClassifiedPullFailure = {
  kind: PullFailureKind;
  /** Registry/daemon reason only — never credentials. */
  detail: string;
};

const AUTH_PATTERNS = [
  /access forbidden/i,
  /pull access denied/i,
  /denied:/i,
  /\bunauthorized\b/i,
  /authentication required/i,
  /authorization failed/i,
  /invalid username\/password/i,
  /insufficient[_ ]scope/i,
  /\b401\b/,
  /\b403\b/,
];

const PULL_PREFIX = /^Docker pull .+ failed:\s*(.+)$/s;

function extractDetail(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message.trim()
      : typeof err === "string"
        ? err.trim()
        : "";
  if (raw === "") return "pull failed";
  const matched = PULL_PREFIX.exec(raw);
  const detail = (matched?.[1] ?? raw).trim();
  if (detail === "") return "pull failed";
  // Bound length so CLI/stderr stays readable; never echo secrets from env.
  return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}

function isAuthDetail(detail: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(detail));
}

/** Map a thrown pull error to a kind + sanitized detail for HTTP/CLI. */
export function classifyPullFailure(err: unknown): ClassifiedPullFailure {
  const detail = extractDetail(err);
  return {
    kind: isAuthDetail(detail) ? "auth" : "other",
    detail,
  };
}
