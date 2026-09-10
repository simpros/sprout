import { describe, expect, test } from "bun:test";
import {
  encodeRegistryAuthHeader,
  registryHostFromImageRef,
  registryServerAddress,
  resolveRegistryAuth,
  xRegistryAuthHeader,
} from "./registry-auth.ts";

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
  const store = {
    byHost: new Map([
      ["ghcr.io", { username: "gh", password: "gh-tok" }],
      ["registry.gitlab.com", { username: "gl", password: "gl-tok" }],
    ]),
  };

  test("looks up creds by image host", () => {
    expect(resolveRegistryAuth("ghcr.io/org/app:t", store)).toEqual({
      username: "gh",
      password: "gh-tok",
      serveraddress: "ghcr.io",
    });
    expect(
      resolveRegistryAuth("registry.gitlab.com/g/seed:t", store),
    ).toEqual({
      username: "gl",
      password: "gl-tok",
      serveraddress: "registry.gitlab.com",
    });
  });

  test("anonymous when host has no match and no fallback", () => {
    expect(resolveRegistryAuth("quay.io/org/app:t", store)).toBeUndefined();
    expect(
      resolveRegistryAuth("ubuntu:22.04", { byHost: new Map() }),
    ).toBeUndefined();
  });

  test("falls back to global pair when host not in map", () => {
    expect(
      resolveRegistryAuth("quay.io/org/app:t", {
        ...store,
        fallback: { username: "global", password: "gpass" },
      }),
    ).toEqual({
      username: "global",
      password: "gpass",
      serveraddress: "quay.io",
    });
  });

  test("map entry wins over global fallback", () => {
    expect(
      resolveRegistryAuth("ghcr.io/org/app:t", {
        ...store,
        fallback: { username: "global", password: "gpass" },
      }),
    ).toEqual({
      username: "gh",
      password: "gh-tok",
      serveraddress: "ghcr.io",
    });
  });

  test("uses Docker Hub serveraddress for docker.io", () => {
    expect(
      resolveRegistryAuth("ubuntu:22.04", {
        byHost: new Map(),
        fallback: { username: "hub", password: "tok" },
      }),
    ).toEqual({
      username: "hub",
      password: "tok",
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
});

describe("xRegistryAuthHeader", () => {
  test("returns undefined when store has no match", () => {
    expect(
      xRegistryAuthHeader("quay.io/org/app:t", { byHost: new Map() }),
    ).toBeUndefined();
  });

  test("encodes resolved AuthConfig", () => {
    const header = xRegistryAuthHeader("ghcr.io/org/app:t", {
      byHost: new Map([["ghcr.io", { username: "u", password: "p" }]]),
    });
    expect(header).toBe(
      encodeRegistryAuthHeader({
        username: "u",
        password: "p",
        serveraddress: "ghcr.io",
      }),
    );
  });
});
