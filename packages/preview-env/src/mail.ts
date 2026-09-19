export const MAIL_MODES = ["enabled", "none"] as const;

export type MailMode = (typeof MAIL_MODES)[number];

export type MailSpec = {
  mode: MailMode;
  /** Optional `{pr_id}` address template overriding the derived From. */
  from?: string;
};

export const DEFAULT_MAIL_FROM_DOMAIN = "preview.invalid";

export function isMailMode(value: string): value is MailMode {
  return (MAIL_MODES as readonly string[]).includes(value);
}

export type MailSpecIssue =
  | { code: "invalid_mail_block"; detail?: string }
  | { code: "unknown_mail_key"; key: string }
  | { code: "invalid_mail_mode"; mode: string }
  | { code: "invalid_mail_from"; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMailFromTemplate(
  raw: string,
): { ok: true } | { ok: false; detail: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, detail: "is required" };
  if (!trimmed.includes("{pr_id}")) {
    return { ok: false, detail: "must contain {pr_id}" };
  }
  const without = trimmed.split("{pr_id}").join("");
  if (without.includes("{") || without.includes("}")) {
    return { ok: false, detail: "supports only {pr_id}" };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, detail: "must not contain whitespace" };
  }
  const probed = trimmed.replaceAll("{pr_id}", "42");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(probed)) {
    return { ok: false, detail: "must be an email address template" };
  }
  return { ok: true };
}

export function deriveMailFrom(
  slug: string,
  prId: number,
  fromDomain: string,
): string {
  return `${slug}-pr${prId}@${fromDomain}`;
}

export function deriveMailFromName(slug: string, prId: number): string {
  return `${slug} PR ${prId}`;
}

export function parseMailSpec(
  raw: unknown,
): { ok: true; value: MailSpec | undefined } | { ok: false; issue: MailSpecIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  // One object path: the string form is sugar for { mode: raw }.
  const obj: unknown = typeof raw === "string" ? { mode: raw } : raw;
  if (!isPlainObject(obj)) {
    return { ok: false, issue: { code: "invalid_mail_block" } };
  }
  for (const key of Object.keys(obj)) {
    if (key !== "mode" && key !== "from") {
      return { ok: false, issue: { code: "unknown_mail_key", key } };
    }
  }
  let mode: MailMode = "enabled";
  if (obj.mode !== undefined) {
    if (typeof obj.mode !== "string" || !isMailMode(obj.mode.trim())) {
      return {
        ok: false,
        issue: { code: "invalid_mail_mode", mode: String(obj.mode) },
      };
    }
    mode = obj.mode.trim() as MailMode;
  }
  let from: string | undefined;
  if (obj.from !== undefined) {
    if (typeof obj.from !== "string" || obj.from.trim() === "") {
      return {
        ok: false,
        issue: { code: "invalid_mail_from", detail: "mail.from is required" },
      };
    }
    const checked = validateMailFromTemplate(obj.from);
    if (!checked.ok) {
      return { ok: false, issue: { code: "invalid_mail_from", detail: checked.detail } };
    }
    from = obj.from.trim();
  }
  // The object form always yields an explicit spec: a bare from defaults to
  // enabled, and an empty object is explicit-enabled, never silent omission
  // (omission stays reserved for undefined input).
  if (mode === "none" && from !== undefined) {
    return {
      ok: false,
      issue: {
        code: "invalid_mail_from",
        detail: "requires mail enabled",
      },
    };
  }
  return { ok: true, value: { mode, ...(from !== undefined ? { from } : {}) } };
}

export function mailSpecIssueMessage(issue: MailSpecIssue): string {
  switch (issue.code) {
    case "invalid_mail_block":
      return "mail must be enabled or none";
    case "unknown_mail_key":
      return `unknown key: mail.${issue.key}`;
    case "invalid_mail_mode":
      return `mail must be enabled or none (got ${JSON.stringify(issue.mode)})`;
    case "invalid_mail_from":
      return `mail.from ${issue.detail}`;
  }
}

/** Explicit mail intent: omitted is opportunistic, enabled is required, none is off. */
export type MailIntent = "omitted" | "required" | "off";

export function mailIntent(spec: MailSpec | undefined): MailIntent {
  if (spec === undefined) return "omitted";
  return spec.mode === "none" ? "off" : "required";
}

export type MailIdentity = {
  slug: string;
  prId: number;
  /** Optional `{pr_id}` template overriding the derived From address. */
  from?: string;
};

/** Single resolve for a preview From identity; env and plan share it. */
export type ResolvedMailIdentity = { address: string; name: string };

/**
 * Sole substitution site for the From identity. The deploy/yaml boundary
 * already validates the template via parseMailSpec, so this substitutes
 * directly with no second validation and no throw.
 */
export function resolveMailIdentity(
  fromDomain: string,
  slug: string,
  prId: number,
  from?: string,
): ResolvedMailIdentity {
  const address =
    from !== undefined
      ? from.trim().replaceAll("{pr_id}", String(prId))
      : deriveMailFrom(slug, prId, fromDomain);
  return { address, name: deriveMailFromName(slug, prId) };
}
