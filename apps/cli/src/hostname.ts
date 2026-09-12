import type { HostnameIssue } from "@sprout/preview-env";

/**
 * Single CLI formatter for hostname grammar issues (parse-time and deploy-time).
 */
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
