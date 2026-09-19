import { describe, expect, test } from "bun:test";
import { parseSproutYaml } from "./yaml.ts";

describe("parseSproutYaml mail.from", () => {
  test("accepts string modes", () => {
    expect(
      parseSproutYaml(`slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nmail: enabled\n`),
    ).toMatchObject({ ok: true });
    expect(
      parseSproutYaml(`slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nmail: none\n`),
    ).toMatchObject({ ok: true });
  });

  test("accepts mapping with from template", () => {
    const result = parseSproutYaml(
      `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nmail:\n  mode: enabled\n  from: "noreply+{pr_id}@preview.invalid"\n`,
    );
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        mail: { mode: "enabled", from: "noreply+{pr_id}@preview.invalid" },
      }),
    });
  });

  test("rejects from without {pr_id} with named error", () => {
    expect(
      parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nmail:\n  from: "noreply@preview.invalid"\n`,
      ),
    ).toEqual({
      ok: false,
      error: "mail.from must contain {pr_id}",
    });
  });

  test("rejects unknown mail keys", () => {
    expect(
      parseSproutYaml(
        `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\nmail:\n  bogus: 1\n`,
      ),
    ).toEqual({ ok: false, error: "unknown key: mail.bogus" });
  });

  test("accepts MAILFROM remap via preview.env", () => {
    const result = parseSproutYaml(
      `slug: myapp\npreview:\n  hostname: "pr-{pr_id}.example.com"\n  env:\n    MAILFROM: SMTP_FROM\n`,
    );
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        preview: expect.objectContaining({ env: { MAILFROM: "SMTP_FROM" } }),
      }),
    });
  });
});
