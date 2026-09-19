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
  user?: string;
  password?: string;
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
    ...(cfg.user !== undefined ? { user: cfg.user } : {}),
    ...(cfg.password !== undefined ? { password: cfg.password } : {}),
    ...(cfg.secure ? { secure: true as const } : {}),
    fromDomain: cfg.fromDomain,
    ...(cfg.network !== undefined ? { network: cfg.network } : {}),
    ...(cfg.uiUrl !== undefined ? { uiUrl: cfg.uiUrl } : {}),
  };
}

/** Single resolve+throw for a preview From identity; env and plan share it. */
export type ResolvedMailIdentity = { address: string; name: string };

export function resolveMailIdentity(
  mail: AppDeployMail,
  identity: MailIdentity,
): ResolvedMailIdentity {
  // Templates are validated at the deploy/yaml boundary, so a failure
  // here is a bug: fail loudly instead of sending from the wrong address.
  const address =
    identity.fromTemplate !== undefined
      ? (() => {
          const from = resolveMailFrom(identity.fromTemplate, identity.prId);
          if (!from.ok) {
            throw new Error(`invalid mail from template: ${from.detail}`);
          }
          return from.value;
        })()
      : deriveMailFrom(identity.slug, identity.prId, mail.fromDomain);
  return { address, name: deriveMailFromName(identity.slug, identity.prId) };
}

export function mailConnectionEnv(
  mail: AppDeployMail,
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
