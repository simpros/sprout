export type PreviewLabels = Record<string, string>;

/** Fail malformed keys at parse: Docker applies labels verbatim, so a typo'd key would silently do nothing. */
export const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type LabelMapIssue =
  | { code: "not_a_mapping" }
  | { code: "empty_key" }
  | { code: "invalid_key"; key: string }
  | { code: "invalid_value"; key: string }
  | { code: "empty_value"; key: string };

export function parseLabelMap(
  raw: unknown,
):
  | { ok: true; value: PreviewLabels | undefined }
  | { ok: false; issue: LabelMapIssue } {  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issue: { code: "not_a_mapping" } };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };
  const out: PreviewLabels = {};
  for (const [key, value] of entries) {
    if (key.trim() === "") {
      return { ok: false, issue: { code: "empty_key" } };
    }
    if (!LABEL_KEY_RE.test(key)) {
      return { ok: false, issue: { code: "invalid_key", key } };
    }
    if (typeof value !== "string") {
      return { ok: false, issue: { code: "invalid_value", key } };
    }
    if (value.trim() === "") {
      return { ok: false, issue: { code: "empty_value", key } };
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

export function labelIssueMessage(path: string, issue: LabelMapIssue): string {
  switch (issue.code) {
    case "not_a_mapping":
      return `${path} must be a mapping`;
    case "empty_key":
      return `${path} key is required`;
    case "invalid_key":
      return `${path}.${issue.key} is invalid`;
    case "invalid_value":
      return `${path}.${issue.key} must be a string`;
    case "empty_value":
      return `${path}.${issue.key} is required`;
  }
}
