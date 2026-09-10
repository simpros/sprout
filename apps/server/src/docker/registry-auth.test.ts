import { describe, expect, test } from "bun:test";
import {
  encodeRegistryAuthHeader,
  parseRegistryAuthsJson,
  registryHostFromImageRef,
  registryServerAddress,
  resolveRegistryAuth,
} from "./registry-auth.ts";

describe("parseRegistryAuthsJson", () => {
  test("empty string yields empty map", () => {
    expect(parseRegistryAuthsJson("")).toEqual(new Map());
    expect(parseRegistryAuthsJson("  ")).toEqual(new Map());
  });

  test("parses per-host user/password map", () => {
    const map = parseRegistryAuthsJson(
      JSON.stringify({
        "ghcr.io": { user: "gh", password: "gh-token" },
        "registry.gitlab.com": { user: "gl", password: "gl-token" },
      }),
    );
    expect(map.get("ghcr.io")).toEqual({
      username: "gh",
      password: "gh-token",
    });
    expect(map.get("registry.gitlab.com")).toEqual({
      username: "gl",
      password: "gl-token",
    });
  });

  test("normalizes host keys to lowercase", () => {
    const map = parseRegistryAuthsJson(
      JSON.stringify({ "GHCR.IO": { user: "u", password: "p" } }),
    );
    expect(map.get("ghcr.io")).toEqual({ username: "u", password: "p" });
  });

  test("rejects invalid JSON", () => {
    expect(() => parseRegistryAuthsJson("{")).toThrow(
      "must be valid JSON",
    );
  });

  test("rejects non-object root", () => {
    expect(() => parseRegistryAuthsJson("[]")).toThrow("expected a JSON object");
    expect(() => parseRegistryAuthsJson('"x"')).toThrow(
      "expected a JSON object",
    );
  });

  test("rejects entry missing user/password strings", () => {
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { user: "u" } }),
      ),
    ).toThrow('entry for "ghcr.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { password: "p" } }),
      ),
    ).toThrow('entry for "ghcr.io"');
  });

  test("rejects password without user", () => {
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { user: "", password: "p" } }),
      ),
    ).toThrow("password is set but user is empty");
  });
});

describe("registryHostFromImageRef", () => {
  test("extracts explicit registry hosts", () => {
    expect(registryHostFromImageRef("ghcr.io/org/app:tag")).toBe("ghcr.io");
    expect(
      registryHostFromImageRef("registry.gitlab.com/group/app:1.0"),
    ).toBe("registry.gitlab.com");
    expect(registryHostFromImageRef("localhost:5000/app:latest")).toBe(
      "localhost:5000",
    );
    expect(registryHostFromImageRef("registry.example.com:443/a/b@sha256:abc")).toBe(
      "registry.example.com:443",
    );
  });

  test("defaults short names to docker.io", () => {
    expect(registryHostFromImageRef("ubuntu")).toBe("docker.io");
    expect(registryHostFromImageRef("ubuntu:22.04")).toBe("docker.io");
    expect(registryHostFromImageRef("library/nginx:latest")).toBe("docker.io");
  });
});

describe("resolveRegistryAuth", () => {
  const auths = new Map([
    ["ghcr.io", { username: "gh", password: "gh-tok" }],
    ["registry.gitlab.com", { username: "gl", password: "gl-tok" }],
  ]);

  test("looks up creds by image host", () => {
    expect(resolveRegistryAuth("ghcr.io/org/app:t", auths)).toEqual({
      credential: { username: "gh", password: "gh-tok" },
      serveraddress: "ghcr.io",
    });
    expect(
      resolveRegistryAuth("registry.gitlab.com/g/seed:t", auths),
    ).toEqual({
      credential: { username: "gl", password: "gl-tok" },
      serveraddress: "registry.gitlab.com",
    });
  });

  test("anonymous when host has no match and no fallback", () => {
    expect(resolveRegistryAuth("quay.io/org/app:t", auths)).toBeUndefined();
    expect(resolveRegistryAuth("ubuntu:22.04", new Map())).toBeUndefined();
  });

  test("falls back to global pair when host not in map", () => {
    expect(
      resolveRegistryAuth("quay.io/org/app:t", auths, {
        username: "global",
        password: "gpass",
      }),
    ).toEqual({
      credential: { username: "global", password: "gpass" },
      serveraddress: "quay.io",
    });
  });

  test("map entry wins over global fallback", () => {
    expect(
      resolveRegistryAuth("ghcr.io/org/app:t", auths, {
        username: "global",
        password: "gpass",
      }),
    ).toEqual({
      credential: { username: "gh", password: "gh-tok" },
      serveraddress: "ghcr.io",
    });
  });

  test("uses Docker Hub serveraddress for docker.io", () => {
    expect(
      resolveRegistryAuth("ubuntu:22.04", new Map(), {
        username: "hub",
        password: "tok",
      }),
    ).toEqual({
      credential: { username: "hub", password: "tok" },
      serveraddress: registryServerAddress("docker.io"),
    });
  });
});

describe("encodeRegistryAuthHeader", () => {
  test("includes serveraddress in AuthConfig", () => {
    const header = encodeRegistryAuthHeader({
      username: "u",
      password: "p",
      serveraddress: "ghcr.io",
    });
    expect(header).toBe(
      Buffer.from(
        JSON.stringify({
          username: "u",
          password: "p",
          serveraddress: "ghcr.io",
        }),
      ).toString("base64"),
    );
  });

  test("omits header for empty username", () => {
    expect(
      encodeRegistryAuthHeader({
        username: "",
        password: "",
        serveraddress: "ghcr.io",
      }),
    ).toBeUndefined();
    expect(encodeRegistryAuthHeader(undefined)).toBeUndefined();
  });
});
