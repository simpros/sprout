import { describe, expect, test } from "bun:test";
import { mailConnectionEnv } from "./mail-env.ts";
import type { MailConfig } from "../config.ts";
import { withGatewayConnectionEnv } from "./pg-env.ts";

const mail: MailConfig = {
  host: "mailpit",
  port: 1025,
  user: "mailpit",
  password: "mailpit",
  secure: false,
  fromDomain: "preview.invalid",
};

const identity = { slug: "myapp", prId: 42 };

describe("mailConnectionEnv", () => {
  test("resolves derived From/FromName/ReplyTo with the connection env", () => {
    expect(mailConnectionEnv(mail, identity).env).toEqual([
      "MAILHOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
      "MAILFROM=myapp-pr42@preview.invalid",
      "MAILFROMNAME=myapp PR 42",
      "MAILREPLYTO=myapp-pr42@preview.invalid",
    ]);
  });

  test("from template override resolves per preview", () => {
    const { env } = mailConnectionEnv(mail, {
      ...identity,
      fromTemplate: "noreply+{pr_id}@preview.invalid",
    });
    expect(env).toContain("MAILFROM=noreply+42@preview.invalid");
  });

  test("secure and uiUrl only emit when configured", () => {
    expect(
      mailConnectionEnv(
        {
          ...mail,
          secure: true,
          uiUrl: "https://mail.example.com",
        },
        identity,
      ).env,
    ).toEqual([
      "MAILHOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
      "MAILSECURE=true",
      "MAILUIURL=https://mail.example.com",
      "MAILFROM=myapp-pr42@preview.invalid",
      "MAILFROMNAME=myapp PR 42",
      "MAILREPLYTO=myapp-pr42@preview.invalid",
    ]);
  });

  test("omitted credentials emit no MAILUSER/MAILPASSWORD", () => {
    expect(
      mailConnectionEnv(
        {
          host: "mailpit",
          port: 1025,
          secure: false,
          fromDomain: "preview.invalid",
        },
        identity,
      ).env,
    ).toEqual([
      "MAILHOST=mailpit",
      "MAILPORT=1025",
      "MAILFROM=myapp-pr42@preview.invalid",
      "MAILFROMNAME=myapp PR 42",
      "MAILREPLYTO=myapp-pr42@preview.invalid",
    ]);
  });

  test("full remap replaces names with no dual alias", () => {
    expect(
      mailConnectionEnv(mail, identity, {
        MAILHOST: "SMTP_HOST",
        MAILPORT: "SMTP_PORT",
        MAILUSER: "SMTP_USER",
        MAILPASSWORD: "SMTP_PASS",
      }).env,
    ).toEqual([
      "SMTP_HOST=mailpit",
      "SMTP_PORT=1025",
      "SMTP_USER=mailpit",
      "SMTP_PASS=mailpit",
      "MAILFROM=myapp-pr42@preview.invalid",
      "MAILFROMNAME=myapp PR 42",
      "MAILREPLYTO=myapp-pr42@preview.invalid",
    ]);
  });

  test("partial remap keeps unmapped keys canonical", () => {
    expect(
      mailConnectionEnv(mail, identity, { MAILHOST: "SMTP_HOST" }).env,
    ).toEqual([
      "SMTP_HOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
      "MAILFROM=myapp-pr42@preview.invalid",
      "MAILFROMNAME=myapp PR 42",
      "MAILREPLYTO=myapp-pr42@preview.invalid",
    ]);
  });
});

describe("mail reservation via withGatewayConnectionEnv", () => {
  test("preview.app_env cannot override a canonical mail key", () => {
    const gateway = mailConnectionEnv(mail, identity).env;
    expect(
      withGatewayConnectionEnv(["FIXTURE_SET=demo", "MAILHOST=attacker"], gateway),
    ).toEqual(["FIXTURE_SET=demo", ...gateway]);
  });

  test("remapped target names are reserved too", () => {
    const remapped = mailConnectionEnv(mail, identity, {
      MAILHOST: "SMTP_HOST",
    }).env;
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "SMTP_HOST=attacker", "MAILPORT=evil"],
        remapped,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...remapped]);
  });
});
