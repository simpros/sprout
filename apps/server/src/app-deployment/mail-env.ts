import {
  resolveMailIdentity as resolvePreviewMailIdentity,
  type MailEnvKey,
  type MailIdentity as PreviewMailIdentity,
  type PreviewEnvMap,
  type ResolvedMailIdentity,
} from "@sprout/preview-env";
import type { MailConfig } from "../config.ts";

export type MailIdentity = PreviewMailIdentity;

export type { ResolvedMailIdentity };

/** Thin caller over the single preview-env substitution site. */
export function resolveMailIdentity(
  mail: MailConfig,
  identity: MailIdentity,
): ResolvedMailIdentity {
  return resolvePreviewMailIdentity(
    mail.fromDomain,
    identity.slug,
    identity.prId,
    identity.fromTemplate,
  );
}

export function mailConnectionEnv(
  mail: MailConfig,
  connectionEnv?: PreviewEnvMap,
  /** Already-resolved identity; callers resolve once via resolveMailIdentity. */
  resolved?: ResolvedMailIdentity,
): string[] {
  const fields: [MailEnvKey, string][] = [
    ["MAILHOST", mail.host],
    ["MAILPORT", String(mail.port)],
  ];
  if (mail.user !== undefined) fields.push(["MAILUSER", mail.user]);
  if (mail.password !== undefined) fields.push(["MAILPASSWORD", mail.password]);
  if (mail.secure === true) fields.push(["MAILSECURE", "true"]);
  if (mail.uiUrl !== undefined && mail.uiUrl !== "") {
    fields.push(["MAILUIURL", mail.uiUrl]);
  }
  if (resolved !== undefined) {
    fields.push(["MAILFROM", resolved.address]);
    fields.push(["MAILFROMNAME", resolved.name]);
    fields.push(["MAILREPLYTO", resolved.address]);
  }
  return fields.map(([key, value]) => `${connectionEnv?.[key] ?? key}=${value}`);
}
