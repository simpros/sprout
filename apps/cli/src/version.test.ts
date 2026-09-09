import { describe, expect, test } from "bun:test";
import { cliVersion } from "./version.ts";

describe("cliVersion", () => {
  test("defaults to dev when SPROUT_CLI_VERSION is not injected", () => {
    expect(cliVersion()).toBe("dev");
  });
});
