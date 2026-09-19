import {
  resolveMailIdentity as resolvePreviewMailIdentity,
  type MailEnvKey,
  type MailIdentity as PreviewMailIdentity,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import type { MailConfig } from "../config.ts";

export type MailIdentity = PreviewMailIdentity;

/** Single canonical call: resolves the From identity once and builds the connection env. */
export function mailConnectionEnv(
  mail: MailConfig,
  identity: MailIdentity,
  connectionEnv?: PreviewEnvMap,
): { env: string[]; resolved: { address: string; name: string } } {
  const resolved = resolvePreviewMailIdentity(
    mail.fromDomain,
    identity.slug,
    identity.prId,
    identity.fromTemplate,
  );
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
  fields.push(["MAILFROM", resolved.address]);
  fields.push(["MAILFROMNAME", resolved.name]);
  fields.push(["MAILREPLYTO", resolved.address]);
  return {
    env: fields.map(([key, value]) => `${connectionEnv?.[key] ?? key}=${value}`),
    resolved,
  };
}
