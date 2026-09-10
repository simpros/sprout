import { describe, expect, test } from "bun:test";
import {
  authedContext,
  isLocalGatewayHostname,
  requireToken,
  resolveAdminTokenPath,
  type CliDeps,
} from "./context.ts";

function deps(
  env: NodeJS.ProcessEnv,
  overrides: Partial<CliDeps> = {},
): CliDeps {
  return {
    env,
    cwd: "/",
    readTextFile: async () => null,
    getGitRemoteUrl: () => null,
    createClient: () => ({}) as ReturnType<CliDeps["createClient"]>,
    io: { stdout: () => {}, stderr: () => {} },
    ...overrides,
  };
}

describe("isLocalGatewayHostname", () => {
  test("recognizes loopback hosts", () => {
    expect(isLocalGatewayHostname("127.0.0.1")).toBe(true);
    expect(isLocalGatewayHostname("localhost")).toBe(true);
    expect(isLocalGatewayHostname("::1")).toBe(true);
    expect(isLocalGatewayHostname("[::1]")).toBe(true);
  });

  test("rejects remote hosts", () => {
    expect(isLocalGatewayHostname("sprout.example")).toBe(false);
    expect(isLocalGatewayHostname("192.168.1.10")).toBe(false);
  });
});

describe("resolveAdminTokenPath", () => {
  test("defaults to well-known admin-token path", () => {
    expect(resolveAdminTokenPath({})).toBe("admin-token");
  });

  test("uses SPROUT_ADMIN_TOKEN_PATH when set", () => {
    expect(
      resolveAdminTokenPath({ SPROUT_ADMIN_TOKEN_PATH: "/data/admin-token" }),
    ).toBe("/data/admin-token");
  });

  test("does not derive from SPROUT_STATE_DB_PATH", () => {
    expect(
      resolveAdminTokenPath({ SPROUT_STATE_DB_PATH: "/data/sprout.db" }),
    ).toBe("admin-token");
  });
});

describe("requireToken", () => {
  test("prefers SPROUT_TOKEN over SPROUT_ADMIN_TOKEN", async () => {
    expect(
      await requireToken(
        deps({
          SPROUT_TOKEN: "deploy",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toEqual({ ok: true, value: "deploy" });
  });

  test("falls back to SPROUT_ADMIN_TOKEN for default local URL", async () => {
    expect(await requireToken(deps({ SPROUT_ADMIN_TOKEN: "admin" }))).toEqual({
      ok: true,
      value: "admin",
    });
  });

  test("falls back to SPROUT_ADMIN_TOKEN for explicit localhost", async () => {
    expect(
      await requireToken(
        deps({
          SPROUT_URL: "http://localhost:7331",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toEqual({ ok: true, value: "admin" });
  });

  test("falls back to admin token file on loopback when env is blank", async () => {
    expect(
      await requireToken(
        deps(
          { SPROUT_ADMIN_TOKEN_PATH: "/data/admin-token" },
          {
            readTextFile: async (path) =>
              path === "/data/admin-token" ? "file-admin\n" : null,
          },
        ),
      ),
    ).toEqual({ ok: true, value: "file-admin" });
  });

  test("does not use SPROUT_ADMIN_TOKEN against a remote URL", async () => {
    expect(
      await requireToken(
        deps({
          SPROUT_URL: "https://sprout.example",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toEqual({ ok: false, error: "SPROUT_TOKEN is required" });
  });

  test("does not read admin token file against a remote URL", async () => {
    expect(
      await requireToken(
        deps(
          { SPROUT_URL: "https://sprout.example" },
          { readTextFile: async () => "file-admin" },
        ),
      ),
    ).toEqual({ ok: false, error: "SPROUT_TOKEN is required" });
  });

  test("returns local error when neither token nor file is set", async () => {
    expect(await requireToken(deps({}))).toEqual({
      ok: false,
      error: "SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required",
    });
  });

  test("rejects invalid SPROUT_URL instead of treating it as remote", async () => {
    expect(
      await requireToken(
        deps({
          SPROUT_URL: "not-a-url",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toEqual({ ok: false, error: "invalid SPROUT_URL" });
  });
});

describe("authedContext", () => {
  test("errors with local message when no token on loopback", async () => {
    const result = await authedContext(deps({}));
    expect(result).toEqual({
      ok: false,
      error: "SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required",
    });
  });

  test("errors with remote message when no SPROUT_TOKEN off-loopback", async () => {
    const result = await authedContext(
      deps({
        SPROUT_URL: "https://sprout.example",
        SPROUT_ADMIN_TOKEN: "admin",
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "SPROUT_TOKEN is required",
    });
  });

  test("propagates invalid SPROUT_URL from requireToken", async () => {
    const result = await authedContext(
      deps({
        SPROUT_URL: "://bad",
        SPROUT_ADMIN_TOKEN: "admin",
      }),
    );
    expect(result).toEqual({ ok: false, error: "invalid SPROUT_URL" });
  });
});
