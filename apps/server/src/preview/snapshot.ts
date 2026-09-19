import { deriveMailFromName } from "@sprout/preview-env";
import type { Result } from "./result.ts";
import type { PreviewRow } from "./row.ts";
import type { PreviewSnapshot, PreviewStatus } from "./types.ts";

/**
 * Single home for the mailbox invariant: a preview with no From identity
 * (mail:none) never advertises the config-level mailbox link. Snapshots and
 * the list endpoint share it so the two cannot drift.
 */
export function mailFieldsFor(
  slug: string,
  prId: number,
  storedFrom: string | undefined,
  mailboxUrl?: string,
): Pick<PreviewSnapshot, "mailbox_url" | "mail_from" | "mail_from_name"> {
  if (storedFrom === undefined) return {};
  return {
    ...(mailboxUrl !== undefined ? { mailbox_url: mailboxUrl } : {}),
    mail_from: storedFrom,
    mail_from_name: deriveMailFromName(slug, prId),
  };
}

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

export function previewSnapshotFromRow(
  row: PreviewRow,
  mailboxUrl?: string,
): PreviewSnapshot {
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
    ...mailFieldsFor(row.slug, row.prId, effectiveFrom, mailboxUrl),
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
    reset_request_marker: row.resetRequestMarker,
  };
}

/**
 * Route-layer decorator: attach the config-level mailbox link to an
 * already-built snapshot. Lifecycle layers return mail-free snapshots;
 * only the HTTP edge applies this, so domain code never threads presentation.
 */
export function withMailbox(
  snapshot: PreviewSnapshot,
  mailboxUrl: string | undefined,
): PreviewSnapshot {
  return {
    ...snapshot,
    ...mailFieldsFor(
      snapshot.slug,
      snapshot.pr_id,
      snapshot.mail_from,
      mailboxUrl,
    ),
  };
}
