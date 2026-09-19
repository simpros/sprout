import type { Result } from "./result.ts";
import type { PreviewRow } from "./row.ts";
import type {
  PreviewSnapshot,
  PreviewStatus,
  ProvisionInput,
} from "./types.ts";

/** Mail presentation attached to a snapshot: mailbox link plus From identity. */
export type MailPresentation = {
  mailboxUrl?: string;
  mailFrom?: string;
  mailFromName?: string;
};

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
  mail?: MailPresentation,
): PreviewSnapshot {
  const status = parsePreviewStatus(row.status);
  const parsed = status.ok ? status.value : "failed";
  const effectiveFrom = mail?.mailFrom ?? row.mailFrom ?? undefined;
  const effectiveName =
    mail?.mailFromName ??
    (effectiveFrom !== undefined ? `${row.slug} PR ${row.prId}` : undefined);
  const mailboxUrl = mail?.mailboxUrl;
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: parsed,
    ...(parsed === "running" ? { preview_url: `https://${row.hostname}` } : {}),
    // The mailbox link is config-level, but a preview with no From identity
    // (mail:none) must not advertise it.
    ...(mailboxUrl !== undefined && effectiveFrom !== undefined
      ? { mailbox_url: mailboxUrl }
      : {}),
    ...(effectiveFrom !== undefined ? { mail_from: effectiveFrom } : {}),
    ...(effectiveName !== undefined ? { mail_from_name: effectiveName } : {}),
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
    reset_request_marker: row.resetRequestMarker,
  };
}

/** Snapshot for a deploy intent: the plan carries the whole presentation. */
export function snapshotForPlan(
  row: PreviewRow,
  plan: ProvisionInput["plan"],
): PreviewSnapshot {
  return previewSnapshotFromRow(row, {
    ...(plan.mailboxUrl !== undefined ? { mailboxUrl: plan.mailboxUrl } : {}),
    ...(plan.mailFrom !== undefined ? { mailFrom: plan.mailFrom } : {}),
    ...(plan.mailFromName !== undefined
      ? { mailFromName: plan.mailFromName }
      : {}),
  });
}
