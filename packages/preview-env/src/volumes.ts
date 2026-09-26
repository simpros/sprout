/** Per-preview app-data volumes (`preview.volumes`). */

export type PreviewVolumeIssue =
  | { code: "volumes_not_a_list" }
  | { code: "volumes_empty"; index: number }
  | { code: "volume_not_absolute"; index: number; path: string }
  | { code: "volume_dotdot"; index: number; path: string }
  | { code: "volume_duplicate"; index: number; path: string }
  | { code: "volume_collides_db_path"; index: number; path: string };

function normalizeContainerPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function hasDotDotSegment(path: string): boolean {
  return path.split("/").includes("..");
}

export function parsePreviewVolumes(
  raw: unknown,
  opts: { dbPath?: string } = {},
): { ok: true; value: string[] | undefined } | { ok: false; issue: PreviewVolumeIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, issue: { code: "volumes_not_a_list" } };
  if (raw.length === 0) return { ok: true, value: undefined };
  const out: string[] = [];
  const seen = new Set<string>();
  const dbPath =
    opts.dbPath !== undefined ? normalizeContainerPath(opts.dbPath) : undefined;
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        issue: {
          code: "volumes_empty",
          index,
        },
      };
    }
    const trimmed = entry.trim();
    if (!trimmed.startsWith("/")) {
      return { ok: false, issue: { code: "volume_not_absolute", index, path: entry } };
    }
    if (hasDotDotSegment(trimmed)) {
      return { ok: false, issue: { code: "volume_dotdot", index, path: entry } };
    }
    const normalized = normalizeContainerPath(trimmed);
    if (seen.has(normalized)) {
      return { ok: false, issue: { code: "volume_duplicate", index, path: entry } };
    }
    if (dbPath !== undefined && normalized === dbPath) {
      return {
        ok: false,
        issue: { code: "volume_collides_db_path", index, path: entry },
      };
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return { ok: true, value: out };
}

export function previewVolumeIssueMessage(
  path: string,
  issue: PreviewVolumeIssue,
): string {
  switch (issue.code) {
    case "volumes_not_a_list":
      return `${path} must be a list`;
    case "volumes_empty":
      return `${path}[${issue.index}] is required`;
    case "volume_not_absolute":
      return `${path}[${issue.index}] must be an absolute container path (got ${JSON.stringify(issue.path)})`;
    case "volume_dotdot":
      return `${path}[${issue.index}] must not contain .. (got ${JSON.stringify(issue.path)})`;
    case "volume_duplicate":
      return `${path}: duplicate entry: ${JSON.stringify(issue.path)}`;
    case "volume_collides_db_path":
      return `${path}[${issue.index}] collides with db.path (got ${JSON.stringify(issue.path)})`;
  }
}
