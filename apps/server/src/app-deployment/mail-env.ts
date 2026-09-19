import {
  deriveMailFrom,
  deriveMailFromName,
  resolveMailFrom,
  type MailEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";

export type AppDeployMail = {
  host: string;
  port: number;
  user: string;
  password: string;
  secure?: boolean;
  uiUrl?: string;
  fromDomain: string;
};

export type MailIdentity = {
  slug: string;
  prId: number;
  /** Optional `{pr_id}` template overriding the derived From address. */
  fromTemplate?: string;
};

export function mailConnectionEnv(
  mail: AppDeployMail,
  connectionEnv?: PreviewEnvMap,
  identity?: MailIdentity,
): string[] {
  const fields: [MailEnvKey, string][] = [
    ["MAILHOST", mail.host],
    ["MAILPORT", String(mail.port)],
    ["MAILUSER", mail.user],
    ["MAILPASSWORD", mail.password],
  ];
  if (mail.secure === true) fields.push(["MAILSECURE", "true"]);
  if (mail.uiUrl !== undefined && mail.uiUrl !== "") {
    fields.push(["MAILUIURL", mail.uiUrl]);
  }
  if (identity !== undefined) {
    const from =
      identity.fromTemplate !== undefined
        ? resolveMailFrom(identity.fromTemplate, identity.prId)
        : null;
    const address =
      from !== null
        ? from.ok
          ? from.value
          : deriveMailFrom(identity.slug, identity.prId, mail.fromDomain)
        : deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
    const name = deriveMailFromName(identity.slug, identity.prId);
    fields.push(["MAILFROM", address]);
    fields.push(["MAILFROMNAME", name]);
    fields.push(["MAILREPLYTO", address]);
  }
  return fields.map(([key, value]) => `${connectionEnv?.[key] ?? key}=${value}`);
}

export function resolveMailFromAddress(
  mail: AppDeployMail,
  identity: MailIdentity,
): string {
  if (identity.fromTemplate !== undefined) {
    const resolved = resolveMailFrom(identity.fromTemplate, identity.prId);
    if (resolved.ok) return resolved.value;
  }
  return deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
}
