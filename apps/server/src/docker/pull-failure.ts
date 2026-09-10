/** Sanitize Engine pull errors for CLI-safe detail (never credentials). */

const PULL_PREFIX = /^Docker pull .+ failed:\s*(.+)$/s;

/** Strip Engine pull prefix and bound length for HTTP/CLI detail. */
export function extractPullDetail(err: unknown): string {
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
