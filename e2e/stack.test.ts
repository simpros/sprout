import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

describe.skipIf(!enabled)("compose stack", () => {
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
