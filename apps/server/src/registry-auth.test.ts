import { describe, expect, test } from "bun:test";
import {
  buildRegistryPullAuth,
  canonicalizeRegistryHost,
  encodeRegistryAuthHeader,
  parseRegistryAuthsJson,
  registryHostFromImageRef,
  registryServerAddress,
  resolveRegistryAuth,
  xRegistryAuthHeader,
} from "./registry-auth.ts";

describe("canonicalizeRegistryHost", () => {
  test("collapses Docker Hub synonyms", () => {
    expect(canonicalizeRegistryHost("index.docker.io")).toBe("docker.io");
    expect(canonicalizeRegistryHost("registry-1.docker.io")).toBe("docker.io");
    expect(canonicalizeRegistryHost("Docker.IO")).toBe("docker.io");
    expect(canonicalizeRegistryHost("ghcr.io")).toBe("ghcr.io");
  });

  test("extracts authority: strips scheme and path", () => {
    expect(canonicalizeRegistryHost("https://index.docker.io/v1/")).toBe(
      "docker.io",
    );
    expect(canonicalizeRegistryHost("http://index.docker.io/v1")).toBe(
      "docker.io",
    );
    expect(canonicalizeRegistryHost("https://registry-1.docker.io/v2/")).toBe(
      "docker.io",
    );
    expect(canonicalizeRegistryHost("docker.io/v1")).toBe("docker.io");
    expect(canonicalizeRegistryHost("https://ghcr.io/v2/")).toBe("ghcr.io");
    expect(canonicalizeRegistryHost("https://registry.gitlab.com/v2/")).toBe(
      "registry.gitlab.com",
    );
    expect(canonicalizeRegistryHost("registry.gitlab.com:443/foo")).toBe(
      "registry.gitlab.com:443",
    );
  });

  test("strips scheme so https://ghcr.io matches image-ref host", () => {
    expect(canonicalizeRegistryHost("https://ghcr.io")).toBe("ghcr.io");
    expect(canonicalizeRegistryHost("https://ghcr.io/")).toBe("ghcr.io");
  });
});

describe("parseRegistryAuthsJson", () => {
  test("empty string yields empty map", () => {
    expect(parseRegistryAuthsJson("")).toEqual(new Map());
    expect(parseRegistryAuthsJson("  ")).toEqual(new Map());
  });

  test("parses per-host username/password map", () => {
    const map = parseRegistryAuthsJson(
      JSON.stringify({
        "ghcr.io": { username: "gh", password: "gh-token" },
        "registry.gitlab.com": { username: "gl", password: "gl-token" },
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
      JSON.stringify({ "GHCR.IO": { username: "u", password: "p" } }),
    );
    expect(map.get("ghcr.io")).toEqual({ username: "u", password: "p" });
  });

  test("canonicalizes Docker Hub synonyms to docker.io", () => {
    const map = parseRegistryAuthsJson(
      JSON.stringify({
        "index.docker.io": { username: "hub", password: "tok" },
      }),
    );
    expect(map.get("docker.io")).toEqual({
      username: "hub",
      password: "tok",
    });
    expect(map.has("index.docker.io")).toBe(false);

    const map2 = parseRegistryAuthsJson(
      JSON.stringify({
        "registry-1.docker.io": { username: "hub2", password: "tok2" },
      }),
    );
    expect(map2.get("docker.io")).toEqual({
      username: "hub2",
      password: "tok2",
    });

    const map3 = parseRegistryAuthsJson(
      JSON.stringify({
        "https://index.docker.io/v1/": { username: "hub3", password: "tok3" },
      }),
    );
    expect(map3.get("docker.io")).toEqual({
      username: "hub3",
      password: "tok3",
    });
  });

  test("strips path from non-Hub URL keys", () => {
    const map = parseRegistryAuthsJson(
      JSON.stringify({
        "https://ghcr.io/v2/": { username: "u", password: "p" },
      }),
    );
    expect(map.get("ghcr.io")).toEqual({ username: "u", password: "p" });
    expect(map.has("ghcr.io/v2")).toBe(false);
  });

  test("rejects duplicate hosts after canonicalize", () => {
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({
          "GHCR.IO": { username: "a", password: "1" },
          "ghcr.io": { username: "b", password: "2" },
        }),
      ),
    ).toThrow('duplicate registry host "ghcr.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({
          "index.docker.io": { username: "a", password: "1" },
          "docker.io": { username: "b", password: "2" },
        }),
      ),
    ).toThrow('duplicate registry host "docker.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({
          "https://index.docker.io/v1/": { username: "a", password: "1" },
          "docker.io": { username: "b", password: "2" },
        }),
      ),
    ).toThrow('duplicate registry host "docker.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({
          "https://ghcr.io/v2/": { username: "a", password: "1" },
          "ghcr.io": { username: "b", password: "2" },
        }),
      ),
    ).toThrow('duplicate registry host "ghcr.io"');
  });

  test("rejects invalid JSON", () => {
    expect(() => parseRegistryAuthsJson("{")).toThrow("must be valid JSON");
  });

  test("rejects non-object root", () => {
    expect(() => parseRegistryAuthsJson("[]")).toThrow("expected a JSON object");
    expect(() => parseRegistryAuthsJson('"x"')).toThrow(
      "expected a JSON object",
    );
  });

  test("rejects entry missing username/password strings", () => {
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { username: "u" } }),
      ),
    ).toThrow('entry for "ghcr.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { password: "p" } }),
      ),
    ).toThrow('entry for "ghcr.io"');
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { user: "u", password: "p" } }),
      ),
    ).toThrow("expected string fields username and password");
  });

  test("rejects empty username", () => {
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { username: "", password: "p" } }),
      ),
    ).toThrow("username must be non-empty");
    expect(() =>
      parseRegistryAuthsJson(
        JSON.stringify({ "ghcr.io": { username: "", password: "" } }),
      ),
    ).toThrow("username must be non-empty");
  });
});

describe("buildRegistryPullAuth", () => {
  test("assembles map + legacy fallback", () => {
    const store = buildRegistryPullAuth({
      authsJson: JSON.stringify({
        "ghcr.io": { username: "gh", password: "gh-tok" },
      }),
      legacyUser: "puller",
      legacyPassword: "secret",
    });
    expect(store.byHost.get("ghcr.io")).toEqual({
      username: "gh",
      password: "gh-tok",
    });
    expect(store.fallback).toEqual({
      username: "puller",
      password: "secret",
    });
  });

  test("omits fallback when legacy user empty", () => {
    const store = buildRegistryPullAuth({
      authsJson: "",
      legacyUser: "",
      legacyPassword: "",
    });
    expect(store.byHost.size).toBe(0);
    expect(store.fallback).toBeUndefined();
  });

  test("rejects password without user", () => {
    expect(() =>
      buildRegistryPullAuth({
        authsJson: "",
        legacyUser: "",
        legacyPassword: "only-password",
      }),
    ).toThrow(
      "SPROUT_REGISTRY_PASSWORD is set but SPROUT_REGISTRY_USER is empty",
    );
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

  test("canonicalizes Hub synonym hosts in image refs", () => {
    expect(registryHostFromImageRef("index.docker.io/library/ubuntu:22.04")).toBe(
      "docker.io",
    );
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

  test("JSON key index.docker.io matches short-name pulls", () => {
    const byHost = parseRegistryAuthsJson(
      JSON.stringify({
        "index.docker.io": { username: "hub", password: "tok" },
      }),
    );
    expect(resolveRegistryAuth("ubuntu:22.04", { byHost })).toEqual({
      username: "hub",
      password: "tok",
      serveraddress: registryServerAddress("docker.io"),
    });
  });

  test("JSON key https://index.docker.io/v1/ matches short-name pulls", () => {
    const byHost = parseRegistryAuthsJson(
      JSON.stringify({
        "https://index.docker.io/v1/": { username: "hub", password: "tok" },
      }),
    );
    expect(byHost.get("docker.io")).toEqual({
      username: "hub",
      password: "tok",
    });
    expect(resolveRegistryAuth("ubuntu:22.04", { byHost })).toEqual({
      username: "hub",
      password: "tok",
      serveraddress: registryServerAddress("docker.io"),
    });
  });

  test("JSON key https://ghcr.io/v2/ matches ghcr image pulls", () => {
    const byHost = parseRegistryAuthsJson(
      JSON.stringify({
        "https://ghcr.io/v2/": { username: "gh", password: "tok" },
      }),
    );
    expect(resolveRegistryAuth("ghcr.io/org/app:t", { byHost })).toEqual({
      username: "gh",
      password: "tok",
      serveraddress: "ghcr.io",
    });
  });

  test("JSON key docker.io/v1 matches short-name pulls", () => {
    const byHost = parseRegistryAuthsJson(
      JSON.stringify({
        "docker.io/v1": { username: "hub", password: "tok" },
      }),
    );
    expect(resolveRegistryAuth("ubuntu:22.04", { byHost })).toEqual({
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
