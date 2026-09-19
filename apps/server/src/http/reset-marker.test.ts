import { afterEach, describe, expect, test } from "bun:test";
import { bearer, createTestApp, postDeployToken, type TestApp } from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
});

function deployPayload() {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    slug: "myapp",
    hostname: "pr-42.myapp.preview.example.com",
    app_image: "ghcr.io/org/myapp:sha-abc",
  };
}

async function deployWith(app: TestApp, token: string) {
  const res = await app.app.handle(
    new Request("http://localhost/v1/deploy", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify(deployPayload()),
    }),
  );
  expect(res.status).toBe(202);
}

async function setMarker(
  app: TestApp,
  token: string,
  body: Record<string, unknown>,
) {
  const res = await app.app.handle(
    new Request("http://localhost/v1/reset-marker", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function getPreview(app: TestApp, token: string) {
  const res = await app.app.handle(
    new Request(
      `http://localhost/v1/preview?canonical_repo_id=${encodeURIComponent(REPO)}&pr_id=42`,
      { headers: bearer(token) },
    ),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/reset-marker", () => {
  test("deploy token records the marker and GET /v1/preview exposes it", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    await deployWith(testApp, body.token);

    const before = await getPreview(testApp, body.token);
    expect(before.status).toBe(200);
    expect(before.body.reset_request_marker).toBeNull();

    const set = await setMarker(testApp, body.token, {
      canonical_repo_id: REPO,
      pr_id: 42,
      marker: "ada-1",
    });
    expect(set.status).toBe(200);

    const after = await getPreview(testApp, body.token);
    expect(after.status).toBe(200);
    expect(after.body.reset_request_marker).toBe("ada-1");
  });

  test("marker survives teardown so a retry sees it as handled", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    await deployWith(testApp, body.token);
    await setMarker(testApp, body.token, {
      canonical_repo_id: REPO,
      pr_id: 42,
      marker: "ada-1",
    });

    const torn = await testApp.app.handle(
      new Request("http://localhost/v1/teardown", {
        method: "POST",
        headers: { ...bearer(body.token), "content-type": "application/json" },
        body: JSON.stringify({ canonical_repo_id: REPO, pr_id: 42 }),
      }),
    );
    expect(torn.status).toBe(200);

    // Removed rows are not readable, but re-marking the same token still lands.
    const again = await setMarker(testApp, body.token, {
      canonical_repo_id: REPO,
      pr_id: 42,
      marker: "ada-1",
    });
    expect(again.status).toBe(200);
    expect(again.body.reset_request_marker).toBe("ada-1");

    // A redeploy over the tombstoned row keeps the handled marker.
    await deployWith(testApp, body.token);
    const redeployed = await getPreview(testApp, body.token);
    expect(redeployed.status).toBe(200);
    expect(redeployed.body.reset_request_marker).toBe("ada-1");
  });

  test("missing row is 404", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const set = await setMarker(testApp, body.token, {
      canonical_repo_id: REPO,
      pr_id: 42,
      marker: "ada-1",
    });
    expect(set.status).toBe(404);
    expect(set.body).toEqual({ error: "preview_not_found" });
  });

  test("invalid markers are 422", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    await deployWith(testApp, body.token);
    for (const marker of ["", "   ", "a<b", "x".repeat(257)]) {
      const set = await setMarker(testApp, body.token, {
        canonical_repo_id: REPO,
        pr_id: 42,
        marker,
      });
      expect(set.status).toBe(422);
    }
  });

  test("cross-repo deploy token is forbidden", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const set = await setMarker(testApp, body.token, {
      canonical_repo_id: "https://github.com/org/other",
      pr_id: 42,
      marker: "ada-1",
    });
    expect(set.status).toBe(403);
  });

  test("missing token is 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/reset-marker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          pr_id: 42,
          marker: "ada-1",
        }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
