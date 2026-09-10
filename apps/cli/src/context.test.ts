import { describe, expect, test } from "bun:test";
import {
  authedContext,
  isLocalGatewayUrl,
  requireToken,
  type CliDeps,
} from "./context.ts";

function deps(env: NodeJS.ProcessEnv): CliDeps {
  return {
    env,
    cwd: "/",
    readTextFile: async () => null,
    getGitRemoteUrl: () => null,
    createClient: () => ({}) as ReturnType<CliDeps["createClient"]>,
    io: { stdout: () => {}, stderr: () => {} },
  };
}

describe("isLocalGatewayUrl", () => {
  test("recognizes loopback hosts", () => {
    expect(isLocalGatewayUrl("http://127.0.0.1:7331")).toBe(true);
    expect(isLocalGatewayUrl("http://localhost:7331")).toBe(true);
    expect(isLocalGatewayUrl("http://[::1]:7331")).toBe(true);
  });

  test("rejects remote hosts", () => {
    expect(isLocalGatewayUrl("https://sprout.example")).toBe(false);
    expect(isLocalGatewayUrl("http://192.168.1.10:7331")).toBe(false);
  });
});

describe("requireToken", () => {
  test("prefers SPROUT_TOKEN over SPROUT_ADMIN_TOKEN", () => {
    expect(
      requireToken(
        deps({
          SPROUT_TOKEN: "deploy",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toBe("deploy");
  });

  test("falls back to SPROUT_ADMIN_TOKEN for default local URL", () => {
    expect(requireToken(deps({ SPROUT_ADMIN_TOKEN: "admin" }))).toBe("admin");
  });

  test("falls back to SPROUT_ADMIN_TOKEN for explicit localhost", () => {
    expect(
      requireToken(
        deps({
          SPROUT_URL: "http://localhost:7331",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toBe("admin");
  });

  test("does not use SPROUT_ADMIN_TOKEN against a remote URL", () => {
    expect(
      requireToken(
        deps({
          SPROUT_URL: "https://sprout.example",
          SPROUT_ADMIN_TOKEN: "admin",
        }),
      ),
    ).toBeNull();
  });

  test("returns null when neither token is set", () => {
    expect(requireToken(deps({}))).toBeNull();
  });
});

describe("authedContext", () => {
  test("errors with local message when no token on loopback", () => {
    const result = authedContext(deps({}));
    expect(result).toEqual({
      ok: false,
      error: "SPROUT_TOKEN or SPROUT_ADMIN_TOKEN is required",
    });
  });

  test("errors with remote message when no SPROUT_TOKEN off-loopback", () => {
    const result = authedContext(
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
});
