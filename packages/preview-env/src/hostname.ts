/** Preview hostname template + host validation (single grammar for CLI + gateway). */

export const HOSTNAME_PLACEHOLDER = "{pr_id}";

/** Sentinel digit used at parse time so templates share {@link validateHostname}. */
const TEMPLATE_SENTINEL = "0";

/** Lowercase hostname label: starts/ends alnum, interior hyphens allowed. */
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export type HostnameIssue =
  | { code: "hostname_template_missing_placeholder" }
  | { code: "hostname_template_invalid"; detail: string }
  | { code: "invalid_hostname"; detail: string };

/**
 * How a hostname field may be shaped:
 * - `required_template` — must contain `{pr_id}` (preview.hostname)
 * - `static_or_template` — static host, or a `{pr_id}` template (service hostname)
 */
export type HostnameMode = "required_template" | "static_or_template";

/** True when the value is treated as a `{pr_id}` template under `mode`. */
function isHostnameTemplate(raw: string, mode: HostnameMode): boolean {
  if (mode === "required_template") return true;
  // Any brace means "intended template" — reject stray `{`/`}` via template rules.
  return raw.includes("{") || raw.includes("}");
}

/**
 * Validate a `.sprout.yaml` hostname template.
 * Placeholder checks, then the same host grammar via a sentinel substitution.
 */
function validateHostnameTemplate(
  template: string,
):
  | { ok: true }
  | { ok: false; issue: HostnameIssue } {
  if (!template.includes(HOSTNAME_PLACEHOLDER)) {
    return {
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    };
  }
  const withoutPlaceholder = template.split(HOSTNAME_PLACEHOLDER).join("");
  if (withoutPlaceholder.includes("{") || withoutPlaceholder.includes("}")) {
    return {
      ok: false,
      issue: {
        code: "hostname_template_invalid",
        detail: "only {pr_id} is supported",
      },
    };
  }
  return validateHostname(
    template.replaceAll(HOSTNAME_PLACEHOLDER, TEMPLATE_SENTINEL),
  );
}

/** Validate a fully-substituted preview host (no scheme, path, or port). */
export function validateHostname(
  host: string,
):
  | { ok: true }
  | { ok: false; issue: HostnameIssue } {
  if (host.length === 0 || host.length > 253) {
    return {
      ok: false,
      issue: { code: "invalid_hostname", detail: "length must be 1-253" },
    };
  }
  const labels = host.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return {
        ok: false,
        issue: { code: "invalid_hostname", detail: "empty or long label" },
      };
    }
    if (!HOST_LABEL_RE.test(label)) {
      return {
        ok: false,
        issue: {
          code: "invalid_hostname",
          detail: `invalid label ${JSON.stringify(label)}`,
        },
      };
    }
  }
  return { ok: true };
}

/**
 * Parse-time shape check for a hostname field (no PR substitution).
 * Same mode policy as {@link resolveHostnameValue}.
 */
export function validateHostnameValue(
  raw: string,
  mode: HostnameMode,
):
  | { ok: true }
  | { ok: false; issue: HostnameIssue } {
  if (isHostnameTemplate(raw, mode)) {
    return validateHostnameTemplate(raw);
  }
  return validateHostname(raw);
}

/**
 * Substitute `{pr_id}` and validate the resulting host.
 * Rejects templates that cannot produce a host for the given PR.
 */
function substituteHostname(
  template: string,
  prId: number,
):
  | { ok: true; value: string }
  | { ok: false; issue: HostnameIssue } {
  const templateCheck = validateHostnameTemplate(template);
  if (!templateCheck.ok) return templateCheck;
  const host = template.replaceAll(HOSTNAME_PLACEHOLDER, String(prId));
  const hostCheck = validateHostname(host);
  if (!hostCheck.ok) return hostCheck;
  return { ok: true, value: host };
}

/**
 * Deploy-time resolve: substitute when the value is a template under `mode`,
 * otherwise validate and return the static host.
 */
export function resolveHostnameValue(
  raw: string,
  prId: number,
  mode: HostnameMode,
):
  | { ok: true; value: string }
  | { ok: false; issue: HostnameIssue } {
  if (isHostnameTemplate(raw, mode)) {
    return substituteHostname(raw, prId);
  }
  const checked = validateHostname(raw);
  if (!checked.ok) return checked;
  return { ok: true, value: raw };
}
