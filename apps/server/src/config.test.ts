import { afterEach, describe, expect, test } from "bun:test";
import {
  configSummary,
  loadConfig,
  OPTIONAL_ENV_DEFAULTS,
  REQUIRED_ENV,
} from "./config.ts";

const TEST_REQUIRED_VALUES: Record<(typeof REQUIRED_ENV)[number], string> = {
  SPROUT_PREVIEW_POSTGRES_URL: "postgres://admin:sekrit@localhost:5432/postgres",
  SPROUT_PG_HOST: "postgres",
  SPROUT_PG_USER: "sprout_preview",
  SPROUT_PG_PASSWORD: "preview-secret",
  SPROUT_TRAEFIK_NETWORK: "traefik",
  SPROUT_POSTGRES_NETWORK: "postgres",
  SPROUT_REGISTRY_URL: "registry.example.com",
  SPROUT_FORGE: "github",
};

function setRequiredEnv(): void {
  for (const key of REQUIRED_ENV) {
    process.env[key] = TEST_REQUIRED_VALUES[key];
  }
  process.env.SPROUT_FORGE_TOKEN = "forge-token";
  process.env.SPROUT_REGISTRY_USER = "puller";
  process.env.SPROUT_REGISTRY_PASSWORD = "registry-secret";
}

function clearGatewayEnv(): void {
  for (const key of REQUIRED_ENV) {
    delete process.env[key];
  }
  delete process.env.SPROUT_FORGE_TOKEN;
  delete process.env.SPROUT_REGISTRY_USER;
  delete process.env.SPROUT_REGISTRY_PASSWORD;
  for (const key of Object.keys(OPTIONAL_ENV_DEFAULTS)) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearGatewayEnv();
});

describe("loadConfig", () => {
  test("fails fast when required vars are missing", () => {
    clearGatewayEnv();
    expect(() => loadConfig()).toThrow(
      `Missing required environment variables: ${REQUIRED_ENV.join(", ")}`,
    );
  });

  test("applies defaults for optional vars", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.forge).toBe("github");
    expect(config.forgeToken).toBe("forge-token");
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

  test("rejects invalid SPROUT_FORGE", () => {
    setRequiredEnv();
    process.env.SPROUT_FORGE = "bitbucket";
    expect(() => loadConfig()).toThrow(
      "Invalid SPROUT_FORGE: must be one of github, gitlab",
    );
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

  test("allows empty registry user/password for anonymous pulls", () => {
    setRequiredEnv();
    delete process.env.SPROUT_REGISTRY_USER;
    delete process.env.SPROUT_REGISTRY_PASSWORD;
    const config = loadConfig();
    expect(config.registryUser).toBe("");
    expect(config.registryPassword).toBe("");
  });

  test("allows empty SPROUT_FORGE_TOKEN at boot (required only for forge API calls)", () => {
    setRequiredEnv();
    delete process.env.SPROUT_FORGE_TOKEN;
    const config = loadConfig();
    expect(config.forgeToken).toBe("");
  });

  test("configSummary marks unset forge token", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin@localhost:5432/postgres",
      previewPgHost: "postgres",
      previewPgPort: 5432,
      previewPgUser: "sprout_preview",
      previewPgPassword: "x",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryUrl: "ghcr.io",
      registryUser: "",
      registryPassword: "",
      forge: "github",
      forgeToken: "",
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });
    expect(summary.forgeToken).toBe("[unset]");
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
      registryUrl: "registry.example.com",
      registryUser: "puller",
      registryPassword: "registry-secret",
      forge: "github",
      forgeToken: "forge-secret",
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });

    expect(String(summary.previewPostgresUrl)).not.toContain("sekrit");
    expect(summary.previewPgPassword).toBe("[set]");
    expect(summary.registryPassword).toBe("[set]");
    expect(summary.registryUser).toBe("puller");
    expect(summary.forge).toBe("github");
    expect(summary.forgeToken).toBe("[set]");
  });

  test("configSummary marks anonymous registry creds", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin@localhost:5432/postgres",
      previewPgHost: "postgres",
      previewPgPort: 5432,
      previewPgUser: "sprout_preview",
      previewPgPassword: "x",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryUrl: "ghcr.io",
      registryUser: "",
      registryPassword: "",
      forge: "gitlab",
      forgeToken: "t",
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });
    expect(summary.registryUser).toBe("[anonymous]");
    expect(summary.registryPassword).toBe("[anonymous]");
  });
});
