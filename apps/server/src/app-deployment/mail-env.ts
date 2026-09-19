import {
  deriveMailFrom,
  deriveMailFromName,
  resolveMailFrom,
  type MailEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import type { MailConfig } from "../config.ts";

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

/** Flat gateway mail presence: connection fields plus attach/ui extras. */
export type MaterializationMail = AppDeployMail & {
  /** Docker network carrying SMTP; absent means no extra attach. */
  network?: string;
};

/** Single constructor from gateway config; boot and tests share it. */
export function toMaterializationMail(cfg: MailConfig): MaterializationMail {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    ...(cfg.secure ? { secure: true as const } : {}),
    fromDomain: cfg.fromDomain,
    ...(cfg.network !== undefined ? { network: cfg.network } : {}),
    ...(cfg.uiUrl !== undefined ? { uiUrl: cfg.uiUrl } : {}),
  };
}

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
    // Templates are validated at the deploy/yaml boundary, so a failure
    // here is a bug: fail loudly instead of sending from the wrong address.
    let address: string;
    if (identity.fromTemplate !== undefined) {
      const from = resolveMailFrom(identity.fromTemplate, identity.prId);
      if (!from.ok) {
        throw new Error(`invalid mail from template: ${from.detail}`);
      }
      address = from.value;
    } else {
      address = deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
    }
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
    if (!resolved.ok) {
      throw new Error(`invalid mail from template: ${resolved.detail}`);
    }
    return resolved.value;
  }
  return deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
}
