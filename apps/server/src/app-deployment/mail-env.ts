import {
  deriveMailFrom,
  deriveMailFromName,
  type MailEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import type { MailConfig } from "../config.ts";

export type MailIdentity = {
  slug: string;
  prId: number;
  /** Optional `{pr_id}` template overriding the derived From address. */
  fromTemplate?: string;
};

/** Single resolve for a preview From identity; env and plan share it. */
export type ResolvedMailIdentity = { address: string; name: string };

export function resolveMailIdentity(
  mail: MailConfig,
  identity: MailIdentity,
): ResolvedMailIdentity {
  // The deploy/yaml boundary already validates the template via
  // parseMailSpec, so by the time identity resolves here it is known-valid:
  // substitute directly with no second validation and no throw.
  const address =
    identity.fromTemplate !== undefined
      ? identity.fromTemplate.trim().replaceAll("{pr_id}", String(identity.prId))
      : deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
  return { address, name: deriveMailFromName(identity.slug, identity.prId) };
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
