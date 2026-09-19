import { describe, expect, test } from "bun:test";
import {
  deriveMailFrom,
  deriveMailFromName,
  mailIntent,
  parseMailSpec,
  resolveMailIdentity,
  validateMailFromTemplate,
} from "./mail.ts";

describe("mail.from template", () => {
  test("derives default From and display name", () => {
    expect(deriveMailFrom("myapp", 42, "preview.invalid")).toBe(
      "myapp-pr42@preview.invalid",
    );
    expect(deriveMailFromName("myapp", 42)).toBe("myapp PR 42");
  });

  test("accepts {pr_id} address templates", () => {
    expect(
      validateMailFromTemplate("noreply+{pr_id}@preview.invalid"),
    ).toEqual({ ok: true });
  });

  test("rejects templates without {pr_id} or with other placeholders", () => {
    expect(validateMailFromTemplate("noreply@preview.invalid").ok).toBe(false);
    expect(validateMailFromTemplate("a+{sha}@x.test").ok).toBe(false);
    expect(validateMailFromTemplate("not-an-address").ok).toBe(false);
  });

  test("parseMailSpec accepts string and mapping forms", () => {
    expect(parseMailSpec("enabled")).toEqual({
      ok: true,
      value: { mode: "enabled" },
    });
    expect(parseMailSpec("none")).toEqual({
      ok: true,
      value: { mode: "none" },
    });
    expect(
      parseMailSpec({ mode: "enabled", from: "noreply+{pr_id}@preview.invalid" }),
    ).toEqual({
      ok: true,
      value: { mode: "enabled", from: "noreply+{pr_id}@preview.invalid" },
    });
    expect(parseMailSpec({ from: "noreply+{pr_id}@preview.invalid" })).toEqual({
      ok: true,
      value: { mode: "enabled", from: "noreply+{pr_id}@preview.invalid" },
    });
  });

  test("parseMailSpec rejects bad from with named issue", () => {
    const bad = parseMailSpec({ from: "no-placeholder" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issue.code).toBe("invalid_mail_from");
    const unknown = parseMailSpec({ bogus: 1 });
    expect(unknown.ok).toBe(false);
  });

  test("parseMailSpec rejects from with mode none", () => {
    const rejected = parseMailSpec({
      mode: "none",
      from: "noreply+{pr_id}@preview.invalid",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issue.code).toBe("invalid_mail_from");
      expect(rejected.issue).toMatchObject({
        detail: "requires mail enabled",
      });
    }
  });

  test("empty object is explicit-enabled, never silent omission", () => {
    const parsed = parseMailSpec({});
    expect(parsed).toEqual({ ok: true, value: { mode: "enabled" } });
    if (parsed.ok) expect(mailIntent(parsed.value)).toBe("required");
  });

  test("rejects templates without a dotted domain", () => {
    expect(validateMailFromTemplate("a+{pr_id}@b").ok).toBe(false);
  });

  test("omitted mail is opportunistic, enabled is required, none is off", () => {
    expect(mailIntent(undefined)).toBe("omitted");
    expect(mailIntent({ mode: "enabled" })).toBe("required");
    expect(mailIntent({ mode: "none" })).toBe("off");
  });

  test("resolveMailIdentity substitutes once for derived and template forms", () => {
    expect(resolveMailIdentity("preview.invalid", "myapp", 42)).toEqual({
      address: "myapp-pr42@preview.invalid",
      name: "myapp PR 42",
    });
    expect(
      resolveMailIdentity(
        "preview.invalid",
        "myapp",
        42,
        "noreply+{pr_id}@preview.invalid",
      ),
    ).toEqual({ address: "noreply+42@preview.invalid", name: "myapp PR 42" });
  });
});
