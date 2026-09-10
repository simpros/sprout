import { describe, expect, test } from "bun:test";
import { classifyPullFailure } from "./pull-failure.ts";

describe("classifyPullFailure", () => {
  test("marks access-forbidden stream errors as auth", () => {
    expect(
      classifyPullFailure(
        new Error("Docker pull registry.example/app:1 failed: access forbidden"),
      ),
    ).toEqual({
      kind: "auth",
      detail: "access forbidden",
    });
  });

  test("marks HTTP 403 as auth", () => {
    expect(
      classifyPullFailure(new Error("Docker pull ghcr.io/org/private:tag failed: 403")),
    ).toEqual({
      kind: "auth",
      detail: "403",
    });
  });

  test("marks pull access denied as auth", () => {
    expect(
      classifyPullFailure(
        new Error("Docker pull ghcr.io/org/private:tag failed: pull access denied"),
      ),
    ).toEqual({
      kind: "auth",
      detail: "pull access denied",
    });
  });

  test("marks denied: resource messages as auth", () => {
    expect(
      classifyPullFailure(
        new Error(
          "Docker pull ghcr.io/org/private:tag failed: denied: requested access to the resource is denied",
        ),
      ),
    ).toEqual({
      kind: "auth",
      detail: "denied: requested access to the resource is denied",
    });
  });

  test("marks non-auth registry errors as other", () => {
    expect(
      classifyPullFailure(
        new Error("Docker pull ghcr.io/org/app:tag failed: manifest unknown"),
      ),
    ).toEqual({
      kind: "other",
      detail: "manifest unknown",
    });
  });

  test("falls back for unknown thrown values", () => {
    expect(classifyPullFailure(null)).toEqual({
      kind: "other",
      detail: "pull failed",
    });
  });
});
