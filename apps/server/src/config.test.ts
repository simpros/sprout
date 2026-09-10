import { afterEach, describe, expect, test } from "bun:test";
import {
  configSummary,
  loadConfig,
  OPTIONAL_ENV_DEFAULTS,
  parseExtraGitlabHosts,
  parseRegistryAuthsJson,
  REQUIRED_ENV,
} from "./config.ts";

const TEST_REQUIRED_VALUES: Record<(typeof REQUIRED_ENV)[number], string> = {
  SPROUT_PREVIEW_POSTGRES_URL: "postgres://admin:sekrit@localhost:5432/postgres",
  SPROUT_PG_HOST: "postgres",
  SPROUT_PG_USER: "sprout_preview",
  SPROUT_PG_PASSWORD: "preview-secret",
  SPROUT_TRAEFIK_NETWORK: "traefik",
  SPROUT_POSTGRES_NETWORK: "postgres",
};

function setRequiredEnv(): void {
  for (const key of REQUIRED_ENV) {
    process.env[key] = TEST_REQUIRED_VALUES[key];
  }
  process.env.SPROUT_GITHUB_TOKEN = "gh-token";
  process.env.SPROUT_GITLAB_TOKEN = "gl-token";
  process.env.SPROUT_REGISTRY_USER = "puller";
  process.env.SPROUT_REGISTRY_PASSWORD = "registry-secret";
}

function clearGatewayEnv(): void {
  for (const key of REQUIRED_ENV) {
    delete process.env[key];
  }
  delete process.env.SPROUT_GITHUB_TOKEN;
  delete process.env.SPROUT_GITLAB_TOKEN;
  delete process.env.SPROUT_FORGE_HOSTS;
  delete process.env.SPROUT_REGISTRY_USER;
  delete process.env.SPROUT_REGISTRY_PASSWORD;
  delete process.env.SPROUT_REGISTRY_AUTHS_JSON;
  delete process.env.SPROUT_REGISTRY_URL;
  for (const key of Object.keys(OPTIONAL_ENV_DEFAULTS)) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearGatewayEnv();
});

describe("parseExtraGitlabHosts", () => {
  test("parses host=gitlab pairs into a set", () => {
    expect(parseExtraGitlabHosts("git.example.com=gitlab,gl.corp=gitlab")).toEqual(
      new Set(["git.example.com", "gl.corp"]),
    );
  });

  test("rejects unknown forge kinds", () => {
    expect(() => parseExtraGitlabHosts("git.example.com=bitbucket")).toThrow(
      "Invalid SPROUT_FORGE_HOSTS",
    );
  });

  test("rejects custom host mapped to github", () => {
    expect(() => parseExtraGitlabHosts("gh.example.com=github")).toThrow(
      "expected host=gitlab",
    );
  });

  test("rejects remapping built-in GitHub hosts", () => {
    expect(() => parseExtraGitlabHosts("github.com=gitlab")).toThrow(
      "built-in GitHub host",
    );
    expect(() => parseExtraGitlabHosts("www.github.com=gitlab")).toThrow(
      "built-in GitHub host",
    );
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

describe("loadConfig", () => {
  test("fails fast when required vars are missing", () => {
    clearGatewayEnv();
    expect(() => loadConfig()).toThrow(
      `Missing required environment variables: ${REQUIRED_ENV.join(", ")}`,
    );
  });

  test("loads per-forge tokens without a gateway-wide forge switch", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.githubToken).toBe("gh-token");
    expect(config.gitlabToken).toBe("gl-token");
  });

  test("applies defaults for optional vars", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.previewPgHost).toBe("postgres");
    expect(config.previewPgPassword).toBe("preview-secret");
    expect(config.previewPgPort).toBe(OPTIONAL_ENV_DEFAULTS.SPROUT_PG_PORT);
    expect(config.ttlHours).toBe(OPTIONAL_ENV_DEFAULTS.SPROUT_TTL_HOURS);
    expect(config.sweepMinutes).toBe(OPTIONAL_ENV_DEFAULTS.SPROUT_SWEEP_MINUTES);
    expect(config.previewPortDefault).toBe(
      OPTIONAL_ENV_DEFAULTS.SPROUT_PREVIEW_PORT_DEFAULT,
    );
    expect(config.seedTimeout).toBe(OPTIONAL_ENV_DEFAULTS.SPROUT_SEED_TIMEOUT);
    expect(config.port).toBe(OPTIONAL_ENV_DEFAULTS.SPROUT_PORT);
  });

  test("parses SPROUT_FORGE_HOSTS", () => {
    setRequiredEnv();
    process.env.SPROUT_FORGE_HOSTS = "git.example.com=gitlab";
    const config = loadConfig();
    expect(config.extraGitlabHosts).toEqual(new Set(["git.example.com"]));
  });

  test("rejects non-numeric optional env vars", () => {
    setRequiredEnv();
    process.env.SPROUT_PORT = "7331x";
    expect(() => loadConfig()).toThrow(
      "Invalid SPROUT_PORT: must be a positive integer",
    );
  });

  test("rejects whitespace-only required env vars", () => {
    setRequiredEnv();
    process.env.SPROUT_PREVIEW_POSTGRES_URL = "   ";
    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: SPROUT_PREVIEW_POSTGRES_URL",
    );
  });

  test("normalizes legacy registry pair into registryPullAuth.fallback", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.registryPullAuth.byHost.size).toBe(0);
    expect(config.registryPullAuth.fallback).toEqual({
      username: "puller",
      password: "registry-secret",
    });
  });

  test("allows empty registry user/password for anonymous pulls", () => {
    setRequiredEnv();
    delete process.env.SPROUT_REGISTRY_USER;
    delete process.env.SPROUT_REGISTRY_PASSWORD;
    const config = loadConfig();
    expect(config.registryPullAuth.byHost.size).toBe(0);
    expect(config.registryPullAuth.fallback).toBeUndefined();
  });

  test("rejects password without registry user", () => {
    setRequiredEnv();
    delete process.env.SPROUT_REGISTRY_USER;
    process.env.SPROUT_REGISTRY_PASSWORD = "only-password";
    expect(() => loadConfig()).toThrow(
      "SPROUT_REGISTRY_PASSWORD is set but SPROUT_REGISTRY_USER is empty",
    );
  });

  test("loads SPROUT_REGISTRY_AUTHS_JSON into registryPullAuth.byHost", () => {
    setRequiredEnv();
    process.env.SPROUT_REGISTRY_AUTHS_JSON = JSON.stringify({
      "ghcr.io": { username: "gh", password: "gh-tok" },
      "registry.gitlab.com": { username: "gl", password: "gl-tok" },
    });
    const config = loadConfig();
    expect(config.registryPullAuth.byHost.get("ghcr.io")).toEqual({
      username: "gh",
      password: "gh-tok",
    });
    expect(config.registryPullAuth.byHost.get("registry.gitlab.com")).toEqual({
      username: "gl",
      password: "gl-tok",
    });
    expect(config.registryPullAuth.fallback).toEqual({
      username: "puller",
      password: "registry-secret",
    });
  });

  test("fails fast on malformed SPROUT_REGISTRY_AUTHS_JSON", () => {
    setRequiredEnv();
    process.env.SPROUT_REGISTRY_AUTHS_JSON = "{not-json";
    expect(() => loadConfig()).toThrow("Invalid SPROUT_REGISTRY_AUTHS_JSON");
  });

  test("ignores stale SPROUT_REGISTRY_URL (host is in app_image)", () => {
    setRequiredEnv();
    process.env.SPROUT_REGISTRY_URL = "stale.example.com";
    expect(() => loadConfig()).not.toThrow();
  });

  test("allows empty forge tokens at boot", () => {
    setRequiredEnv();
    delete process.env.SPROUT_GITHUB_TOKEN;
    delete process.env.SPROUT_GITLAB_TOKEN;
    const config = loadConfig();
    expect(config.githubToken).toBe("");
    expect(config.gitlabToken).toBe("");
  });

  test("configSummary marks unset forge tokens", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin@localhost:5432/postgres",
      previewPgHost: "postgres",
      previewPgPort: 5432,
      previewPgUser: "sprout_preview",
      previewPgPassword: "x",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryPullAuth: { byHost: new Map() },
      githubToken: "",
      gitlabToken: "",
      extraGitlabHosts: new Set(),
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });
    expect(summary.githubToken).toBe("[unset]");
    expect(summary.gitlabToken).toBe("[unset]");
  });

  test("configSummary redacts secrets", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin:sekrit@localhost:5432/postgres",
      previewPgHost: "postgres",
      previewPgPort: 5432,
      previewPgUser: "sprout_preview",
      previewPgPassword: "preview-secret",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryPullAuth: {
        byHost: new Map([
          ["ghcr.io", { username: "gh", password: "secret" }],
        ]),
        fallback: { username: "puller", password: "registry-secret" },
      },
      githubToken: "gh",
      gitlabToken: "gl",
      extraGitlabHosts: new Set(["git.example.com"]),
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });

    expect(String(summary.previewPostgresUrl)).not.toContain("sekrit");
    expect(summary.previewPgPassword).toBe("[set]");
    expect(summary.registryPullAuthHosts).toBe(1);
    expect(summary.registryPullAuthFallback).toBe("[set]");
    expect(summary.githubToken).toBe("[set]");
    expect(summary.gitlabToken).toBe("[set]");
    expect(summary.extraGitlabHosts).toBe(1);
  });

  test("configSummary marks anonymous registry auth", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin@localhost:5432/postgres",
      previewPgHost: "postgres",
      previewPgPort: 5432,
      previewPgUser: "sprout_preview",
      previewPgPassword: "x",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryPullAuth: { byHost: new Map() },
      githubToken: "",
      gitlabToken: "",
      extraGitlabHosts: new Set(),
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });
    expect(summary.registryPullAuthHosts).toBe(0);
    expect(summary.registryPullAuthFallback).toBe("[unset]");
  });
});
