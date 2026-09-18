const HOSTNAME_PLACEHOLDER = "{pr_id}";

const TEMPLATE_SENTINEL = "0";

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export type HostnameIssue =
  | { code: "hostname_template_missing_placeholder" }
  | { code: "hostname_template_invalid"; detail: string }
  | { code: "invalid_hostname"; detail: string };

export type HostnameMode = "required_template" | "static_or_template";

function isHostnameTemplate(raw: string, mode: HostnameMode): boolean {
  if (mode === "required_template") return true;
  return raw.includes("{") || raw.includes("}");
}

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
