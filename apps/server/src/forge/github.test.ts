import { describe, expect, test } from "bun:test";
import { createGitHubForge } from "./github.ts";
import { isForgeApiError } from "./types.ts";

const FIXTURE_URL = new URL("./fixtures/github-open-prs.json", import.meta.url);

describe("createGitHubForge", () => {
  test("lists open PR ids from recorded GitHub fixture", async () => {
    const fixture = await Bun.file(FIXTURE_URL).json();
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async (input) => {
        const url = String(input);
        expect(url).toBe(
          "https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=100",
        );
        return new Response(JSON.stringify(fixture), { status: 200 });
      },
    });
    const ids = await forge.listOpenPrIds("https://github.com/acme/widgets");
    expect(ids).toEqual([12, 34]);
  });

  test("follows Link rel=next for additional pages", async () => {
    const urls: string[] = [];
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (urls.length === 1) {
          return new Response(JSON.stringify([{ number: 1 }]), {
            status: 200,
            headers: {
              link: '<https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=100&page=2>; rel="next"',
            },
          });
        }
        return new Response(JSON.stringify([{ number: 2 }]), { status: 200 });
      },
    });

    const ids = await forge.listOpenPrIds("https://github.com/acme/widgets");
    expect(ids).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
  });

  test("sends Authorization bearer and Accept headers", async () => {
    let auth = "";
    let accept = "";
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        auth = headers.get("authorization") ?? "";
        accept = headers.get("accept") ?? "";
        return new Response("[]", { status: 200 });
      },
    });

    await forge.listOpenPrIds("https://github.com/acme/widgets");
    expect(auth).toBe("Bearer gh-token");
    expect(accept).toBe("application/vnd.github+json");
  });

  test("throws ForgeApiError when GitHub returns non-OK", async () => {
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async () => new Response("boom", { status: 502 }),
    });

    try {
      await forge.listOpenPrIds("https://github.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
    }
  });

  test("throws ForgeApiError when payload is not an array", async () => {
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async () =>
        new Response(JSON.stringify({ number: 1 }), { status: 200 }),
    });

    try {
      await forge.listOpenPrIds("https://github.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect(String(error)).toContain("non-array");
    }
  });

  test("throws ForgeApiError when any PR number is non-finite", async () => {
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async () =>
        new Response(
          JSON.stringify([
            { number: 12 },
            { number: "34" },
            { number: Number.NaN },
            { number: Infinity },
            { title: "no number" },
            { number: 56 },
          ]),
          { status: 200 },
        ),
    });

    try {
      await forge.listOpenPrIds("https://github.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect(String(error)).toContain("unparsable");
    }
  });

  test("throws ForgeApiError 400 for invalid canonical repo id", async () => {
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async () => new Response("[]", { status: 200 }),
    });

    try {
      await forge.listOpenPrIds("not-a-url");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(400);
      expect(String(error)).toContain("Invalid GitHub canonical repo id");
    }
  });

  test("accepts www.github.com hostnames", async () => {
    const forge = createGitHubForge({
      token: "gh-token",
      fetch: async (input) => {
        expect(String(input)).toContain(
          "api.github.com/repos/acme/widgets/pulls",
        );
        return new Response(JSON.stringify([{ number: 5 }]), { status: 200 });
      },
    });
    await expect(
      forge.listOpenPrIds("https://www.github.com/acme/widgets"),
    ).resolves.toEqual([5]);
  });
});
