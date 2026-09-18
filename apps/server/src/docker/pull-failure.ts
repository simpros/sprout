const PULL_PREFIX = /^Docker pull .+ failed:\s*(.+)$/s;

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
  return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}
