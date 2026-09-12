import { describe, expect, test } from "bun:test";
import { resolveHostnameValue } from "@sprout/preview-env";
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

describe("deploy hostname resolve wiring", () => {
  test("required_template substitutes; static_or_template keeps static hosts", () => {
    const preview = resolveHostnameValue(
      "pr-{pr_id}.example.com",
      42,
      "required_template",
    );
    expect(preview).toEqual({ ok: true, value: "pr-42.example.com" });

    const staticSvc = resolveHostnameValue(
      "api.example.com",
      42,
      "static_or_template",
    );
    expect(staticSvc).toEqual({ ok: true, value: "api.example.com" });

    const bad = resolveHostnameValue(
      "pr-42.example.com",
      42,
      "required_template",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(
        hostnameIssueMessage("preview.hostname", bad.issue, { prId: 42 }),
      ).toContain("{pr_id}");
    }
  });
});
