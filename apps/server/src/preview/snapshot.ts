import { deriveMailFromName } from "@sprout/preview-env";
import type { Result } from "./result.ts";
import type { PreviewRow } from "./row.ts";
import type {
  DisplayPreviewStatus,
  PreviewSnapshot,
  PreviewStatus,
} from "./types.ts";

/**
 * Single home for the mailbox invariant: a preview with no From identity
 * (mail:none) never advertises the config-level mailbox link. Snapshots
 * carry only stored mail_from; the HTTP edge adds the link.
 */
export function parsePreviewStatus(status: string): Result<PreviewStatus> {
  switch (status) {
    case "provisioning":
    case "starting":
    case "seeding":
    case "running":
    case "failed":
    case "removing":
    case "removed":
      return { ok: true, value: status };
    default:
      return { ok: false, status: 500, error: "unknown_preview_status" };
  }
}

export function previewSnapshotFromRow(row: PreviewRow): PreviewSnapshot {
  const status = parsePreviewStatus(row.status);
  const parsed = status.ok ? status.value : "failed";
  const effectiveFrom = row.mailFrom ?? undefined;
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: parsed,
    ...(parsed === "running" ? { preview_url: `https://${row.hostname}` } : {}),
    // Mail-free by construction: stored mail_from only, never the
    // config-level mailbox link. The HTTP edge applies presentPreviewSnapshot.
    ...(effectiveFrom !== undefined
      ? {
          mail_from: effectiveFrom,
          mail_from_name: deriveMailFromName(row.slug, row.prId),
        }
      : {}),
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
    reset_request_marker: row.resetRequestMarker,
  };
}

/**
 * Sole presenter for HTTP edges: the stored mail_from plus the config-level
 * mailbox link (never advertised for a mail:none preview). Domain layers
 * return mail-free snapshots or rows; only routes call this.
 */
export function presentPreviewSnapshot(
  row: PreviewRow,
  mailboxUrl: string | undefined,
): PreviewSnapshot {
  const snapshot = previewSnapshotFromRow(row);
  if (snapshot.mail_from === undefined || mailboxUrl === undefined) {
    return snapshot;
  }
  return { ...snapshot, mailbox_url: mailboxUrl };
}

export type ListedPreview = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string | null;
  hostname: string;
  status: DisplayPreviewStatus;
  created_at: string;
  mailbox_url?: string;
  mail_from?: string;
  mail_from_name?: string;
};

/**
 * Sole list presenter: the decorated snapshot plus the list-only wire shape
 * (display status, created_at). Read edges map rows through this with no
 * spreads so preview_url/last_error never leak into the list.
 */
export function presentListedPreview(
  row: PreviewRow,
  mailboxUrl: string | undefined,
  status: DisplayPreviewStatus,
): ListedPreview {
  const snap = presentPreviewSnapshot(row, mailboxUrl);
  return {
    canonical_repo_id: snap.canonical_repo_id,
    pr_id: snap.pr_id,
    slug: snap.slug,
    db_name: snap.db_name,
    hostname: snap.hostname,
    status,
    created_at: row.createdAt,
    ...(snap.mail_from !== undefined ? { mail_from: snap.mail_from } : {}),
    ...(snap.mail_from_name !== undefined
      ? { mail_from_name: snap.mail_from_name }
      : {}),
    ...(snap.mailbox_url !== undefined
      ? { mailbox_url: snap.mailbox_url }
      : {}),
  };
}
