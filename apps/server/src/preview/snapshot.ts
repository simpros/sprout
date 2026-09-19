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

/** Route-layer constructor: a configured UI link becomes snapshot presentation. */
export function mailPresentationOf(
  uiUrl: string | undefined,
): MailPresentation | undefined {
  return uiUrl !== undefined ? { mailboxUrl: uiUrl } : undefined;
}

/**
 * Single home for the mailbox invariant: a preview with no From identity
 * (mail:none) never advertises the config-level mailbox link. Snapshots and
 * the list endpoint share it so the two cannot drift.
 */
export function mailFieldsFor(
  slug: string,
  prId: number,
  storedFrom: string | undefined,
  mail?: MailPresentation,
): Pick<PreviewSnapshot, "mailbox_url" | "mail_from" | "mail_from_name"> {
  if (storedFrom === undefined) return {};
  return {
    ...(mail?.mailboxUrl !== undefined
      ? { mailbox_url: mail.mailboxUrl }
      : {}),
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
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: parsed,
    ...(parsed === "running" ? { preview_url: `https://${row.hostname}` } : {}),
    ...mailFieldsFor(row.slug, row.prId, effectiveFrom, mail),
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
    reset_request_marker: row.resetRequestMarker,
  };
}
