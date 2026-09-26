import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { e2eConfig } from "./harness/config.ts";
import {
  containerMounts,
  dataVolumeName,
  execInContainer,
  previewAppContainerName,
  volumeExists,
} from "./harness/docker.ts";
import { run } from "./harness/exec.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

const VOLUME_PATH = "/data/documents";
const IMAGE_TAG = "sprout-e2e/data-volumes-nonroot:latest";

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

/**
 * The image pre-creates VOLUME_PATH owned by nobody and runs nginx as
 * root; file writes go through `su nobody` so the test proves a non-root
 * runtime user can write the fresh named volume. Docker copies the
 * image's ownership into the empty volume on first mount — an app that
 * neither creates the path in the image nor chowns it in the entrypoint
 * gets a root-owned directory its runtime user cannot write.
 */
async function buildNonRootImage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-e2e-data-volumes-"));
  await writeFile(
    join(dir, "Dockerfile"),
    `FROM nginx:alpine\nRUN mkdir -p ${VOLUME_PATH} && chown nobody:nogroup ${VOLUME_PATH}\n`,
  );
  await run(["docker", "build", "-t", IMAGE_TAG, dir]);
  return IMAGE_TAG;
}

function deployInput(
  prId: number,
  hostname: string,
  appImage: string,
  extra: Record<string, unknown> = {},
) {
  return {
    canonical_repo_id: e2eConfig.canonicalRepoId,
    pr_id: prId,
    slug: e2eConfig.slug,
    hostname,
    app_image: appImage,
    volumes: [VOLUME_PATH],
    health: {
      path: "/",
      interval: "2s",
      timeout: "90s",
      expect: 200,
    },
    ...extra,
  };
}

describe.skipIf(!enabled)("preview app-data volumes", () => {
  test("non-root write survives replace, reset wipes, teardown removes", async () => {
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
    const hostname = `pr-${prId}.e2e-data-volumes.preview.example.com`;
    const volume = dataVolumeName(e2eConfig.slug, prId, 0);
    const name = previewAppContainerName(e2eConfig.slug, prId);
    const appImage = await buildNonRootImage();

    const deployed = await client.v1.deploy.post(
      deployInput(prId, hostname, appImage),
    );
    expect(deployed.error).toBeNull();
    expect(deployed.status).toBe(202);

    await pollRunning(client, prId);

    try {
      const mounts = await containerMounts(name);
      const data = mounts.find((m) => m.Destination === VOLUME_PATH);
      expect(data?.Name).toBe(volume);
      expect(await volumeExists(volume)).toBe(true);

      await execInContainer(name, [
        "su",
        "nobody",
        "-s",
        "/bin/sh",
        "-c",
        "echo data-survives > /data/documents/probe.txt",
      ]);

      const replaced = await client.v1.deploy.post(
        deployInput(prId, hostname, appImage),
      );
      expect(replaced.error).toBeNull();
      expect(replaced.status).toBe(202);
      await pollRunning(client, prId);

      const probe = await execInContainer(name, [
        "cat",
        "/data/documents/probe.txt",
      ]);
      expect(probe.trim()).toBe("data-survives");
      expect(await volumeExists(volume)).toBe(true);

      // `sprout ci reset` is teardown + deploy: same name reused, contents gone.
      const tornForReset = await client.v1.teardown.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
      });
      expect(tornForReset.status).toBe(200);
      expect(await volumeExists(volume)).toBe(false);

      const reset = await client.v1.deploy.post(
        deployInput(prId, hostname, appImage),
      );
      expect(reset.error).toBeNull();
      expect(reset.status).toBe(202);
      await pollRunning(client, prId);
      expect(await volumeExists(volume)).toBe(true);

      const afterReset = await execInContainer(name, [
        "cat",
        "/data/documents/probe.txt",
      ]).catch(() => null);
      expect(afterReset === null || afterReset.trim() !== "data-survives").toBe(
        true,
      );
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
