import { describe, expect, test } from "bun:test";
import { createForgeClient, isForgeApiError } from "./client.ts";

describe("createForgeClient", () => {
  test("returns ForgeApiError 401 when github token is empty for a github repo", async () => {
    const forge = createForgeClient({ githubToken: "", gitlabToken: "gl" });
    try {
      await forge.listOpenPrIds("https://github.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(401);
      expect(String(error)).toContain("Missing GitHub forge token");
      expect(String(error)).toContain("SPROUT_GITHUB_TOKEN");
    }
  });

  test("routes github.com to GitHub API and gitlab.com to GitLab API", async () => {
    const calls: string[] = [];
    const forge = createForgeClient({
      githubToken: "gh-token",
      gitlabToken: "gl-token",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify([{ number: 7 }]), { status: 200 });
        }
        if (url.includes("gitlab.com/api/v4")) {
          return new Response(JSON.stringify([{ iid: 3 }]), { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await expect(
      forge.listOpenPrIds("https://github.com/acme/widgets"),
    ).resolves.toEqual([7]);
    await expect(
      forge.listOpenPrIds("https://gitlab.com/acme/widgets"),
    ).resolves.toEqual([3]);

    expect(calls.some((u) => u.includes("api.github.com"))).toBe(true);
    expect(calls.some((u) => u.includes("gitlab.com/api/v4"))).toBe(true);
  });

  test("host map routes custom GitLab hosts", async () => {
    const forge = createForgeClient({
      githubToken: "",
      gitlabToken: "gl-token",
      hostMap: { "git.example.com": "gitlab" },
      fetch: async (input) => {
        expect(String(input)).toContain("git.example.com/api/v4");
        return new Response(JSON.stringify([{ iid: 9 }]), { status: 200 });
      },
    });
    await expect(
      forge.listOpenPrIds("https://git.example.com/acme/widgets"),
    ).resolves.toEqual([9]);
  });
});
