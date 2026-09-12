import { describe, expect, test } from "bun:test";
import { hostnameIssueMessage } from "./hostname.ts";

describe("hostnameIssueMessage", () => {
  test("formats parse-time and deploy-time wording from one switch", () => {
    expect(
      hostnameIssueMessage("preview.hostname", {
        code: "hostname_template_missing_placeholder",
      }),
    ).toBe("preview.hostname must contain {pr_id}");
    expect(
      hostnameIssueMessage(
        "preview.hostname",
        { code: "hostname_template_missing_placeholder" },
        { prId: 42 },
      ),
    ).toBe("preview.hostname must contain {pr_id} (pr 42)");
    expect(
      hostnameIssueMessage(
        "service hostname",
        { code: "invalid_hostname", detail: "empty or long label" },
        { prId: 7 },
      ),
    ).toBe("service hostname is invalid: empty or long label (pr 7)");
  });
});
