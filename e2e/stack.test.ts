import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import { composeExec } from "./harness/stack.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

describe.skipIf(!enabled)("compose stack", () => {
  test("embedded CLI sprout health works via docker exec", async () => {
    const result = await composeExec("gateway", ["sprout", "health"]);
    const body = JSON.parse(result.stdout) as { ok?: unknown };
    expect(body.ok).toBe(true);
  });

  test("embedded CLI can mint a deploy token via docker exec", async () => {
    const result = await composeExec(
      "gateway",
      [
        "sprout",
        "admin",
        "token",
        "create",
        "--scope",
        "deploy",
        "--repo",
        e2eConfig.canonicalRepoId,
        "--slug",
        e2eConfig.slug,
      ],
      { env: { SPROUT_TOKEN: e2eConfig.adminToken } },
    );
    const body = JSON.parse(result.stdout) as { token?: unknown };
    expect(typeof body.token).toBe("string");
    expect((body.token as string).length).toBeGreaterThan(8);
  });

  test("admin token can create a deploy token", async () => {
    const client = createApiClient(e2eConfig.gatewayUrl, {
      headers: {
        authorization: `Bearer ${e2eConfig.adminToken}`,
      },
    });
    const created = await client.v1.admin.tokens.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      slug: e2eConfig.slug,
    });
    expect(created.status).toBe(201);
    expect(created.error).toBeNull();
    expect(created.data).not.toBeNull();
    expect(created.data?.token.length).toBeGreaterThan(8);

    const list = await client.v1.admin.tokens.get();
    expect(list.status).toBe(200);
    expect(list.error).toBeNull();
    expect(list.data).not.toBeNull();
    expect(
      list.data?.tokens.some(
        (t) =>
          t.scope === "deploy" &&
          t.canonical_repo_id === e2eConfig.canonicalRepoId,
      ),
    ).toBe(true);
  });
});
