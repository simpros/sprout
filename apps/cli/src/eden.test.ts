import { describe, expect, test } from "bun:test";
import { readEden } from "./eden.ts";

describe("readEden failure messages", () => {
  test("includes HTTP status and error code from JSON body", () => {
    const result = readEden({
      data: null,
      error: { value: { error: "health_timeout" } },
      status: 500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.message).toBe("500 health_timeout");
  });

  test("includes HTTP status and raw body when error shape is missing", () => {
    const result = readEden({
      data: null,
      error: { value: "<html>error code: 524</html>" },
      status: 524,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("524");
    expect(result.message).toContain("error code: 524");
  });
});
