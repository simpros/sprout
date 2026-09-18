import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import {
  containerEnv,
  containerMounts,
  envMap,
  previewAppContainerName,
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

describe.skipIf(!enabled)("none preview lifecycle", () => {
  test("bring-up routes and health-gates with no database, teardown sweeps clean", async () => {
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
    const prId = 57;
    const hostname = `pr-${prId}.e2e-none.preview.example.com`;
    const name = previewAppContainerName(e2eConfig.slug, prId);

    const deployed = await client.v1.deploy.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      pr_id: prId,
      slug: e2eConfig.slug,
      hostname,
      app_image: APP_IMAGE,
      db: { provider: "none" },
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
      const status = await client.v1.preview.get({
        query: {
          canonical_repo_id: e2eConfig.canonicalRepoId,
          pr_id: String(prId),
        },
      });
      expect(status.data).toMatchObject({ db_name: null, status: "running" });

      const listed = await admin.v1.previews.get();
      const row = (listed.data as { previews: { pr_id: number }[] }).previews.find(
        (p) => p.pr_id === prId,
      );
      expect(row).toMatchObject({ db_name: null });

      const env = envMap(await containerEnv(name));
      for (const key of [
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGAPPUSER",
        "PGAPPPASSWORD",
        "DATABASE_URL",
      ]) {
        expect(env.has(key)).toBe(false);
      }

      const mounts = await containerMounts(name);
      expect(mounts.filter((m) => m.Destination === "/data")).toEqual([]);
    } finally {
      const torn = await client.v1.teardown.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
      });
      expect(torn.status).toBe(200);
    }

    const doctor = await admin.v1.doctor.get();
    expect(doctor.data).toMatchObject({ ok: true, orphans: [] });
  });
});
