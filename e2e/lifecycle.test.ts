import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import {
  COMPOSE_E2E_ENV_PATH,
  e2eConfig,
  parseEnvFile,
  requireComposeEnv,
} from "./harness/config.ts";
import { containerEnv, envMap } from "./harness/docker.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

/** Public image with EXPOSE 80 — health path `/` (no PG* required to boot). */
const APP_IMAGE = "nginx:alpine";

/** Partial remap: three adopter names + two remaining PG* (replace, not alias). */
const REMAP = {
  PGHOST: "DATABASE_HOST",
  PGUSER: "DATABASE_USER",
  PGPASSWORD: "DATABASE_PASSWORD",
} as const;

describe.skipIf(!enabled)("preview lifecycle", () => {
  test("deploy with preview.env remap exposes adopter names on the app container", async () => {
    const composeEnv = parseEnvFile(COMPOSE_E2E_ENV_PATH);
    const expectedHost = requireComposeEnv(composeEnv, "SPROUT_PG_HOST");
    const expectedUser = requireComposeEnv(composeEnv, "SPROUT_PG_USER");
    const expectedPort = requireComposeEnv(composeEnv, "SPROUT_PG_PORT");

    const admin = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${e2eConfig.adminToken}` },
    });
    const minted = await admin.v1.admin.tokens.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      slug: e2eConfig.slug,
    });
    expect(minted.status).toBe(201);
    expect(minted.data?.token).toBeTruthy();
    const deployToken = minted.data!.token;

    const client = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${deployToken}` },
    });
    const prId = 55;
    const hostname = `pr-${prId}.e2e-remap.preview.example.com`;

    const deployed = await client.v1.deploy.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      pr_id: prId,
      slug: e2eConfig.slug,
      hostname,
      app_image: APP_IMAGE,
      env: { ...REMAP },
      health: {
        path: "/",
        interval: "2s",
        timeout: "90s",
        expect: 200,
      },
    });
    expect(deployed.error).toBeNull();
    expect(deployed.status).toBe(200);
    expect(deployed.data?.status).toBe("running");

    try {
      const name = `sprout-${e2eConfig.slug}-pr-${prId}`;
      const env = envMap(await containerEnv(name));

      expect(env.get("DATABASE_HOST")).toBe(expectedHost);
      expect(env.get("DATABASE_USER")).toBe(expectedUser);
      expect(env.has("DATABASE_PASSWORD")).toBe(true);
      expect(env.get("DATABASE_PASSWORD")).not.toBe("");

      // Unmapped canonical keys stay PG*; remapped keys must not dual-alias.
      expect(env.get("PGPORT")).toBe(expectedPort);
      expect(env.has("PGDATABASE")).toBe(true);
      expect(env.has("PGHOST")).toBe(false);
      expect(env.has("PGUSER")).toBe(false);
      expect(env.has("PGPASSWORD")).toBe(false);
    } finally {
      const torn = await client.v1.teardown.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
      });
      expect(torn.status).toBe(200);
    }
  });
});
