import { resolveHostnameValue, type HostnameIssue } from "@sprout/preview-env";

export function hostnameIssueMessage(
  label: string,
  issue: HostnameIssue,
  opts?: { prId?: number },
): string {
  const prSuffix =
    opts?.prId !== undefined ? ` (pr ${opts.prId})` : "";
  switch (issue.code) {
    case "hostname_template_missing_placeholder":
      return `${label} must contain {pr_id}${prSuffix}`;
    case "hostname_template_invalid":
    case "invalid_hostname":
      return `${label} is invalid: ${issue.detail}${prSuffix}`;
  }
}

export function resolveDeployHostname(
  raw: string,
  prId: number,
  label: string,
  mode: "required_template" | "static_or_template",
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = resolveHostnameValue(raw, prId, mode);
  if (!resolved.ok) {
    return {
      ok: false,
      error: hostnameIssueMessage(label, resolved.issue, { prId }),
    };
  }
  return resolved;
}
