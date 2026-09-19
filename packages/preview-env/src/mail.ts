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

export function resolveMailFrom(
  template: string,
  prId: number,
): { ok: true; value: string } | { ok: false; detail: string } {
  const checked = validateMailFromTemplate(template);
  if (!checked.ok) return checked;
  return { ok: true, value: template.trim().replaceAll("{pr_id}", String(prId)) };
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
  if (typeof raw === "string") {
    const mode = raw.trim();
    if (!isMailMode(mode)) {
      return { ok: false, issue: { code: "invalid_mail_mode", mode: raw as string } };
    }
    return { ok: true, value: { mode: mode as MailMode } };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, issue: { code: "invalid_mail_block" } };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "from") {
      return { ok: false, issue: { code: "unknown_mail_key", key } };
    }
  }
  let mode: MailMode = "enabled";
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !isMailMode(raw.mode.trim())) {
      return {
        ok: false,
        issue: { code: "invalid_mail_mode", mode: String(raw.mode) },
      };
    }
    mode = raw.mode.trim() as MailMode;
  }
  let from: string | undefined;
  if (raw.from !== undefined) {
    if (typeof raw.from !== "string" || raw.from.trim() === "") {
      return {
        ok: false,
        issue: { code: "invalid_mail_from", detail: "mail.from is required" },
      };
    }
    const checked = validateMailFromTemplate(raw.from);
    if (!checked.ok) {
      return { ok: false, issue: { code: "invalid_mail_from", detail: checked.detail } };
    }
    from = raw.from.trim();
  }
  if (raw.mode === undefined && raw.from === undefined) {
    return { ok: true, value: undefined };
  }
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

export function normalizeMailSpec(spec: MailSpec | undefined): MailSpec {
  return spec ?? { mode: "enabled" };
}

export function isMailEnabled(spec: MailSpec | undefined): boolean {
  return normalizeMailSpec(spec).mode !== "none";
}
