import { describe, expect, test } from "bun:test";
import {
  resolveHostnameValue,
  substituteHostname,
  validateHostname,
  validateHostnameTemplate,
  validateHostnameValue,
} from "./hostname.ts";

describe("validateHostnameTemplate", () => {
  test("accepts templates with {pr_id}", () => {
    expect(
      validateHostnameTemplate("pr-{pr_id}.myapp.preview.example.com"),
    ).toEqual({ ok: true });
  });

  test("rejects templates without {pr_id}", () => {
    expect(validateHostnameTemplate("pr-42.example.com")).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
  });

  test("rejects other placeholders", () => {
    expect(
      validateHostnameTemplate("pr-{pr_id}-{sha}.example.com"),
    ).toEqual({
      ok: false,
      issue: {
        code: "hostname_template_invalid",
        detail: "only {pr_id} is supported",
      },
    });
  });

  test("rejects scheme, path, and whitespace", () => {
    for (const template of [
      "https://pr-{pr_id}.example.com",
      "pr-{pr_id}.example.com/preview",
      "pr-{pr_id}.example.com:8080",
      "pr {pr_id}.example.com",
      "PR-{pr_id}.example.com",
    ]) {
      const result = validateHostnameTemplate(template);
      expect(result.ok).toBe(false);
    }
  });
});

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

describe("substituteHostname", () => {
  test("substitutes and validates", () => {
    expect(
      substituteHostname("pr-{pr_id}.example.com", 42),
    ).toEqual({ ok: true, value: "pr-42.example.com" });
  });

  test("fails fast when the template cannot produce a host", () => {
    expect(substituteHostname("static.example.com", 42)).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
    expect(
      substituteHostname("{pr_id}.exa_mple.com", 42),
    ).toMatchObject({ ok: false });
  });
});

describe("validateHostnameValue / resolveHostnameValue", () => {
  test("required_template always requires {pr_id}", () => {
    expect(validateHostnameValue("static.example.com", "required_template")).toEqual({
      ok: false,
      issue: { code: "hostname_template_missing_placeholder" },
    });
    expect(
      resolveHostnameValue("pr-{pr_id}.example.com", 7, "required_template"),
    ).toEqual({ ok: true, value: "pr-7.example.com" });
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
