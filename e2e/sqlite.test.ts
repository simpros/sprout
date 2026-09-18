import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import {
  containerEnv,
  containerMounts,
  envMap,
  execInContainer,
  previewAppContainerName,
  sqliteVolumeName,
  volumeExists,
} from "./harness/docker.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

const APP_IMAGE = "nginx:alpine";

async function pollRunning(
  client: ReturnType<typeof createApiClient>,
  prId: number,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let status: string | undefined;
  while (status !== "running") {
    expect(Date.now() < deadline).toBe(true);
    await Bun.sleep(2_000);
    const polled = await client.v1.preview.get({
      query: {
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: String(prId),
      },
    });
    expect(polled.error).toBeNull();
    expect(polled.status).toBe(200);
    status = polled.data?.status;
  }
}

describe.skipIf(!enabled)("sqlite preview lifecycle", () => {
  test("bring-up mounts a volume, replace keeps data, teardown drops the volume", async () => {
    const admin = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${e2eConfig.adminToken}` },
    });
    const minted = await admin.v1.admin.tokens.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      slug: e2eConfig.slug,
    });
    expect(minted.status).toBe(201);
    const deployToken = minted.data!.token;

    const client = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${deployToken}` },
    });
    const prId = 56;
    const hostname = `pr-${prId}.e2e-sqlite.preview.example.com`;
    const volume = sqliteVolumeName(e2eConfig.slug, prId);
    const name = previewAppContainerName(e2eConfig.slug, prId);

    const deployed = await client.v1.deploy.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      pr_id: prId,
      slug: e2eConfig.slug,
      hostname,
      app_image: APP_IMAGE,
      db: { provider: "sqlite", path: "/data", file: "preview.db" },
      env: { DATABASE_URL: "APP_DATABASE_URL" },
      health: {
        path: "/",
        interval: "2s",
        timeout: "90s",
        expect: 200,
      },
    });
    expect(deployed.error).toBeNull();
    expect(deployed.status).toBe(202);

    await pollRunning(client, prId);

    try {
      const env = envMap(await containerEnv(name));
      expect(env.get("APP_DATABASE_URL")).toBe("file:/data/preview.db");
      expect(env.has("DATABASE_URL")).toBe(false);
      for (const key of [
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGAPPUSER",
        "PGAPPPASSWORD",
      ]) {
        expect(env.has(key)).toBe(false);
      }

      const mounts = await containerMounts(name);
      const data = mounts.find((m) => m.Destination === "/data");
      expect(data?.Name).toBe(volume);
      expect(await volumeExists(volume)).toBe(true);

      await execInContainer(name, [
        "sh",
        "-c",
        "echo sqlite-survives > /data/probe.txt",
      ]);

      const replaced = await client.v1.deploy.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
        slug: e2eConfig.slug,
        hostname,
        app_image: APP_IMAGE,
        db: { provider: "sqlite", path: "/data", file: "preview.db" },
        env: { DATABASE_URL: "APP_DATABASE_URL" },
        health: {
          path: "/",
          interval: "2s",
          timeout: "90s",
          expect: 200,
        },
      });
      expect(replaced.error).toBeNull();
      expect(replaced.status).toBe(202);
      await pollRunning(client, prId);

      const probe = await execInContainer(name, ["cat", "/data/probe.txt"]);
      expect(probe.trim()).toBe("sqlite-survives");
      expect(await volumeExists(volume)).toBe(true);
    } finally {
      const torn = await client.v1.teardown.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
      });
      expect(torn.status).toBe(200);
    }
    expect(await volumeExists(volume)).toBe(false);
  });
});
