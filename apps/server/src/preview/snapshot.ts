import { deriveMailFromName } from "@sprout/preview-env";
import type { Result } from "./result.ts";
import type { PreviewRow } from "./row.ts";
import type {
  PreviewSnapshot,
  PreviewStatus,
  ProvisionInput,
} from "./types.ts";

/** Config-level mail presentation: the mailbox link only. From lives on the row. */
export type MailPresentation = {
  mailboxUrl?: string;
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

/** Single derivation of the stored From column from a resolved plan. */
export function planMailFrom(plan: ProvisionInput["plan"]): string | null {
  return plan.mailFrom ?? null;
}

export function previewSnapshotFromRow(
  row: PreviewRow,
  mail?: MailPresentation,
): PreviewSnapshot {
  const status = parsePreviewStatus(row.status);
  const parsed = status.ok ? status.value : "failed";
  const effectiveFrom = row.mailFrom ?? undefined;
  const effectiveName =
    effectiveFrom !== undefined
      ? deriveMailFromName(row.slug, row.prId)
      : undefined;
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
