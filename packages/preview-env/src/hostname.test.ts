import { describe, expect, test } from "bun:test";
import {
  resolveHostnameValue,
  validateHostname,
  validateHostnameValue,
} from "./hostname.ts";

describe("validateHostname", () => {
  test("accepts substituted hosts", () => {
    expect(validateHostname("pr-42.myapp.preview.example.com")).toEqual({
      ok: true,
    });
  });

  test("rejects scheme, path, and bad labels", () => {
    for (const host of [
      "https://pr-42.example.com",
      "pr-42.example.com/path",
      "-pr-42.example.com",
      "pr-42..example.com",
      "pr_42.example.com",
    ]) {
      expect(validateHostname(host).ok).toBe(false);
    }
  });
});

describe("validateHostnameValue / resolveHostnameValue", () => {
  test("required_template accepts {pr_id} templates", () => {
    expect(
      validateHostnameValue(
        "pr-{pr_id}.myapp.preview.example.com",
        "required_template",
      ),
    ).toEqual({ ok: true });
    expect(
      resolveHostnameValue("pr-{pr_id}.example.com", 42, "required_template"),
    ).toEqual({ ok: true, value: "pr-42.example.com" });
  });

  test("required_template always requires {pr_id}", () => {
    expect(validateHostnameValue("static.example.com", "required_template")).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
    expect(
      resolveHostnameValue("pr-42.example.com", 7, "required_template"),
    ).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
  });

  test("rejects other placeholders", () => {
    expect(
      validateHostnameValue("pr-{pr_id}-{sha}.example.com", "required_template"),
    ).toEqual({
      ok: false,
      issue: {
        code: "hostname_template_invalid",
        detail: "only {pr_id} is supported",
      },
    });
  });

  test("rejects scheme, path, and whitespace at parse time", () => {
    for (const template of [
      "https://pr-{pr_id}.example.com",
      "pr-{pr_id}.example.com/preview",
      "pr-{pr_id}.example.com:8080",
      "pr {pr_id}.example.com",
      "PR-{pr_id}.example.com",
    ]) {
      expect(validateHostnameValue(template, "required_template").ok).toBe(false);
    }
  });

  test("rejects templates that can never produce a valid host", () => {
    for (const template of [
      "pr-{pr_id}..com",
      "-{pr_id}.example.com",
      "pr-{pr_id}-.example.com",
      ".{pr_id}.example.com",
      "pr-{pr_id}.example.com.",
    ]) {
      const parsed = validateHostnameValue(template, "required_template");
      expect(parsed.ok).toBe(false);
      expect(
        resolveHostnameValue(template, 42, "required_template").ok,
      ).toBe(false);
    }
  });

  test("static_or_template accepts static hosts and templates", () => {
    expect(
      validateHostnameValue("api.example.com", "static_or_template"),
    ).toEqual({ ok: true });
    expect(
      resolveHostnameValue("api.example.com", 7, "static_or_template"),
    ).toEqual({ ok: true, value: "api.example.com" });
    expect(
      resolveHostnameValue("api-{pr_id}.example.com", 7, "static_or_template"),
    ).toEqual({ ok: true, value: "api-7.example.com" });
  });

  test("static_or_template treats stray braces as templates", () => {
    expect(
      validateHostnameValue("api-{sha}.example.com", "static_or_template"),
    ).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
    expect(
      resolveHostnameValue("api-{sha}.example.com", 7, "static_or_template"),
    ).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
  });
});
