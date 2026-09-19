import { createApiClient } from "@sprout/api-client";
import { describe, expect, test } from "bun:test";
import {
  COMPOSE_E2E_ENV_PATH,
  e2eConfig,
  parseEnvFile,
  requireComposeEnv,
} from "./harness/config.ts";
import {
  containerEnv,
  envMap,
  previewAppContainerName,
} from "./harness/docker.ts";
import { sendMail } from "./harness/smtp.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";

const APP_IMAGE = "nginx:alpine";

type MailpitMessage = {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
};

describe.skipIf(!enabled)("preview mail", () => {
  test("example app sends and Mailpit API reads back the deployment From", async () => {
    const composeEnv = parseEnvFile(COMPOSE_E2E_ENV_PATH);
    const smtpPort = Number(
      requireComposeEnv(composeEnv, "MAILPIT_SMTP_HOST_PORT"),
    );
    const uiPort = requireComposeEnv(composeEnv, "MAILPIT_UI_HOST_PORT");
    const fromDomain =
      composeEnv["SPROUT_MAIL_FROM_DOMAIN"]?.trim() || "preview.invalid";
    const mailpitApi = `http://127.0.0.1:${uiPort}/api/v1/messages`;

    const admin = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${e2eConfig.adminToken}` },
    });
    const minted = await admin.v1.admin.tokens.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      slug: e2eConfig.slug,
    });
    expect(minted.status).toBe(201);
    const client = createApiClient(e2eConfig.gatewayUrl, {
      headers: { authorization: `Bearer ${minted.data!.token}` },
    });

    const prId = 56;
    const expectedFrom = `${e2eConfig.slug}-pr${prId}@${fromDomain}`;
    const expectedName = `${e2eConfig.slug} PR ${prId}`;
    const subject = `e2e-mail-${Date.now()}`;

    const deployed = await client.v1.deploy.post({
      canonical_repo_id: e2eConfig.canonicalRepoId,
      pr_id: prId,
      slug: e2eConfig.slug,
      hostname: `pr-${prId}.e2e-mail.preview.example.com`,
      app_image: APP_IMAGE,
      health: { path: "/", interval: "2s", timeout: "90s", expect: 200 },
    });
    expect(deployed.error).toBeNull();
    expect(deployed.status).toBe(202);

    const deadline = Date.now() + 90_000;
    let status = deployed.data?.status;
    let snapshot: unknown = deployed.data;
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
      status = (polled.data as { status?: string })?.status;
      snapshot = polled.data;
    }
    expect(
      (snapshot as { mail_from?: string })?.mail_from,
    ).toBe(expectedFrom);

    try {
      const env = envMap(
        await containerEnv(previewAppContainerName(e2eConfig.slug, prId)),
      );
      expect(env.get("MAILFROM")).toBe(expectedFrom);
      expect(env.get("MAILFROMNAME")).toBe(expectedName);
      expect(env.get("MAILREPLYTO")).toBe(expectedFrom);

      await sendMail({
        host: "127.0.0.1",
        port: smtpPort,
        from: expectedFrom,
        fromName: expectedName,
        to: "tester@example.com",
        subject,
        body: "hello from e2e",
      });

      let found: MailpitMessage | undefined;
      const apiDeadline = Date.now() + 30_000;
      while (!found && Date.now() < apiDeadline) {
        const res = await fetch(mailpitApi);
        expect(res.ok).toBe(true);
        const data = (await res.json()) as {
          messages?: MailpitMessage[];
        };
        found = data.messages?.find((m) => m.Subject === subject);
        if (!found) await Bun.sleep(1_000);
      }
      expect(found).toBeTruthy();
      expect(found!.From.Address).toBe(expectedFrom);
      expect(found!.From.Name).toBe(expectedName);
    } finally {
      const torn = await client.v1.teardown.post({
        canonical_repo_id: e2eConfig.canonicalRepoId,
        pr_id: prId,
      });
      expect(torn.status).toBe(200);
    }
  });
});
