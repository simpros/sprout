import { describe, expect, test } from "bun:test";
import {
  mailConnectionEnv,
  resolveMailIdentity,
  type AppDeployMail,
} from "./mail-env.ts";
import { withGatewayConnectionEnv } from "./pg-env.ts";

const mail: AppDeployMail = {
  host: "mailpit",
  port: 1025,
  user: "mailpit",
  password: "mailpit",
  fromDomain: "preview.invalid",
};

const identity = { slug: "myapp", prId: 42 };

describe("mailConnectionEnv", () => {
  test("absent remap emits canonical MAIL* without secure/ui", () => {
    expect(mailConnectionEnv(mail)).toEqual([
      "MAILHOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
    ]);
  });

  test("identity adds derived From/FromName/ReplyTo", () => {
    const resolved = resolveMailIdentity(mail, identity);
    expect(mailConnectionEnv(mail, undefined, resolved)).toEqual([
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
    const resolved = resolveMailIdentity(mail, {
      ...identity,
      fromTemplate: "noreply+{pr_id}@preview.invalid",
    });
    expect(mailConnectionEnv(mail, undefined, resolved)).toContain(
      "MAILFROM=noreply+42@preview.invalid",
    );
  });

  test("secure and uiUrl only emit when configured", () => {
    expect(
      mailConnectionEnv({
        ...mail,
        secure: true,
        uiUrl: "https://mail.example.com",
      }),
    ).toEqual([
      "MAILHOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
      "MAILSECURE=true",
      "MAILUIURL=https://mail.example.com",
    ]);
  });

  test("omitted credentials emit no MAILUSER/MAILPASSWORD", () => {
    expect(
      mailConnectionEnv({
        host: "mailpit",
        port: 1025,
        fromDomain: "preview.invalid",
      }),
    ).toEqual(["MAILHOST=mailpit", "MAILPORT=1025"]);
  });

  test("full remap replaces names with no dual alias", () => {
    expect(
      mailConnectionEnv(mail, {
        MAILHOST: "SMTP_HOST",
        MAILPORT: "SMTP_PORT",
        MAILUSER: "SMTP_USER",
        MAILPASSWORD: "SMTP_PASS",
      }),
    ).toEqual([
      "SMTP_HOST=mailpit",
      "SMTP_PORT=1025",
      "SMTP_USER=mailpit",
      "SMTP_PASS=mailpit",
    ]);
  });

  test("partial remap keeps unmapped keys canonical", () => {
    expect(mailConnectionEnv(mail, { MAILHOST: "SMTP_HOST" })).toEqual([
      "SMTP_HOST=mailpit",
      "MAILPORT=1025",
      "MAILUSER=mailpit",
      "MAILPASSWORD=mailpit",
    ]);
  });
});

describe("mail reservation via withGatewayConnectionEnv", () => {
  test("preview.app_env cannot override a canonical mail key", () => {
    const gateway = mailConnectionEnv(mail);
    expect(
      withGatewayConnectionEnv(["FIXTURE_SET=demo", "MAILHOST=attacker"], gateway),
    ).toEqual(["FIXTURE_SET=demo", ...gateway]);
  });

  test("remapped target names are reserved too", () => {
    const remapped = mailConnectionEnv(mail, { MAILHOST: "SMTP_HOST" });
    expect(
      withGatewayConnectionEnv(
        ["FIXTURE_SET=demo", "SMTP_HOST=attacker", "MAILPORT=evil"],
        remapped,
      ),
    ).toEqual(["FIXTURE_SET=demo", ...remapped]);
  });
});
