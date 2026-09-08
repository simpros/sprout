import { describe, expect, test } from "bun:test";
import { createGitLabForge } from "./gitlab.ts";
import { isForgeApiError } from "./types.ts";

const FIXTURE_URL = new URL("./fixtures/gitlab-open-mrs.json", import.meta.url);

describe("createGitLabForge", () => {
  test("lists open MR iids from recorded GitLab fixture", async () => {
    const fixture = await Bun.file(FIXTURE_URL).json();
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async (input) => {
        const url = String(input);
        expect(url).toBe(
          "https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests?state=opened&per_page=100&page=1",
        );
        return new Response(JSON.stringify(fixture), { status: 200 });
      },
    });
    const ids = await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
    expect(ids).toEqual([7, 9]);
  });

  test("pages until a short page", async () => {
    const pages: number[] = [];
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        if (page === 1) {
          return new Response(
            JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ iid: i + 1 }))),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([{ iid: 101 }]), { status: 200 });
      },
    });

    const ids = await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
    expect(pages).toEqual([1, 2]);
    expect(ids).toHaveLength(101);
    expect(ids[0]).toBe(1);
    expect(ids[100]).toBe(101);
  });

  test("sends PRIVATE-TOKEN header", async () => {
    let privateToken = "";
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        privateToken = headers.get("private-token") ?? "";
        return new Response("[]", { status: 200 });
      },
    });

    await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
    expect(privateToken).toBe("gl-token");
  });

  test("throws ForgeApiError when GitLab returns non-OK", async () => {
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async () => new Response("boom", { status: 503 }),
    });

    try {
      await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
    }
  });

  test("throws ForgeApiError when payload is not an array", async () => {
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async () =>
        new Response(JSON.stringify({ iid: 1 }), { status: 200 }),
    });

    try {
      await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect(String(error)).toContain("non-array");
    }
  });

  test("throws ForgeApiError when any MR iid is non-finite", async () => {
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async () =>
        new Response(
          JSON.stringify([
            { iid: 7 },
            { iid: "9" },
            { iid: Number.NaN },
            {},
            { iid: 11 },
          ]),
          { status: 200 },
        ),
    });

    try {
      await forge.listOpenPrIds("https://gitlab.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect(String(error)).toContain("unparsable");
    }
  });


  test("derives API base from self-managed GitLab host", async () => {
    let calledUrl = "";
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async (input) => {
        calledUrl = String(input);
        return new Response("[]", { status: 200 });
      },
    });

    await forge.listOpenPrIds("https://gitlab.example.com/acme/widgets");
    expect(calledUrl).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/merge_requests?state=opened&per_page=100&page=1",
    );
  });

  test("rejects non-http canonical repo ids without hitting the API", async () => {
    let called = false;
    const forge = createGitLabForge({
      token: "gl-token",
      fetch: async () => {
        called = true;
        return new Response("[]", { status: 200 });
      },
    });

    try {
      await forge.listOpenPrIds("ftp://gitlab.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(400);
    }
    expect(called).toBe(false);
  });
});
