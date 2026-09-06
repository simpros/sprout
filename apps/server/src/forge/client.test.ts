import { describe, expect, test } from "bun:test";
import { createForgeClient, isForgeApiError } from "./client.ts";

describe("createForgeClient", () => {
  test("returns ForgeApiError 401 when SPROUT_FORGE_TOKEN is empty", async () => {
    const forge = createForgeClient({ forge: "github", token: "" });
    try {
      await forge.listOpenPrIds("https://github.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(401);
      expect(String(error)).toContain("Missing SPROUT_FORGE_TOKEN");
    }
  });

  test("passes through when token is set", async () => {
    const forge = createForgeClient({
      forge: "github",
      token: "gh-token",
      fetch: async () =>
        new Response(JSON.stringify([{ number: 7 }]), { status: 200 }),
    });
    await expect(
      forge.listOpenPrIds("https://github.com/acme/widgets"),
    ).resolves.toEqual([7]);
  });
});
