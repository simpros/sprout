import { afterEach, describe, expect, test } from "bun:test";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

import type { MailConfig } from "../config.ts";

const MAIL: MailConfig = {
  host: "mailpit",
  port: 1025,
  user: "mailpit",
  password: "mailpit",
  secure: false,
  fromDomain: "preview.invalid",
};

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

async function setup(mail: MailConfig = MAIL) {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
  });
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
    mail,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  return postDeployAndSettle(testApp!, token, body);
}

describe("POST /v1/deploy mail", () => {
  test("injects MAIL* plus derived From into app container", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    const env = fakeDocker!.creates[0]!.env;
    expect(env).toContain("MAILHOST=mailpit");
    expect(env).toContain("MAILPORT=1025");
    expect(env).toContain("MAILFROM=myapp-pr42@preview.invalid");
    expect(env).toContain("MAILFROMNAME=myapp PR 42");
    expect(env).toContain("MAILREPLYTO=myapp-pr42@preview.invalid");
    expect(res.body).toMatchObject({
      mail_from: "myapp-pr42@preview.invalid",
    });
  });

  test("preview.env remaps From keys", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        env: { MAILFROM: "SMTP_FROM", MAILFROMNAME: "SMTP_FROM_NAME" },
      }),
    );
    expect(res.settleStatus).toBe(200);
    const env = fakeDocker!.creates[0]!.env;
    expect(env).toContain("SMTP_FROM=myapp-pr42@preview.invalid");
    expect(env).toContain("SMTP_FROM_NAME=myapp PR 42");
    expect(env).not.toContain("MAILFROM=myapp-pr42@preview.invalid");
  });

  test("mail:none suppresses all mail env and From", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody({ mail: "none" }));
    expect(res.settleStatus).toBe(200);
    const env = fakeDocker!.creates[0]!.env;
    expect(env.find((e) => e.startsWith("MAIL"))).toBeUndefined();
    expect(res.body).not.toHaveProperty("mail_from");
  });

  test("mail:enabled on unconfigured gateway returns mail_not_configured", async () => {
    fakePreviewDb = createFakePreviewDb();
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
    });
    testApp = await createTestApp({
      previewDb: fakePreviewDb,
      docker: fakeDocker,
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const token = body.token as string;
    const res = await postDeploy(token, deployBody({ mail: "enabled" }));
    expect(res.settleStatus).toBe(500);
    expect(res.body).toMatchObject({ error: "mail_not_configured" });
  });

  test("invalid mail.from template rejects with named error", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ mail_from: "not-an-address" }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toMatchObject({ error: "invalid_mail" });
    expect(JSON.stringify(res.body)).toContain("mail.from");
  });

  test("mail.from override resolves per preview", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ mail_from: "noreply+{pr_id}@preview.invalid" }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toContain(
      "MAILFROM=noreply+42@preview.invalid",
    );
    expect(res.body).toMatchObject({ mail_from: "noreply+42@preview.invalid" });
  });

  test("mail network joins created containers; mailbox and From surface on list/preview", async () => {
    const { deployToken } = await setup({
      ...MAIL,
      network: "mailnet",
      uiUrl: "https://mail.example.com",
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.networkNames).toContain("mailnet");
    expect(res.body).toMatchObject({
      mailbox_url: "https://mail.example.com",
      mail_from: "myapp-pr42@preview.invalid",
    });

    const list = await testApp!.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    const listed = (await list.json()) as {
      previews: Array<{ mailbox_url?: string; mail_from?: string }>;
    };
    expect(listed.previews[0]).toMatchObject({
      mailbox_url: "https://mail.example.com",
      mail_from: "myapp-pr42@preview.invalid",
    });
  });
});
