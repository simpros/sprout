import { describe, expect, test } from "bun:test";
import { defaultDbSpec, type DbSpec } from "@sprout/preview-env";
import {
  resolvePreviewPlan,
  type PreviewMaterializationCtx,
} from "./runtime.ts";

const PG = {
  host: "postgres",
  port: 5432,
  user: "sprout_preview",
  password: "sekrit",
};

const MAIL = {
  mail: {
    host: "mailpit",
    port: 1025,
    user: "mailpit",
    password: "mailpit",
    fromDomain: "preview.invalid",
  },
};

const MAIL_FULL = {
  mail: {
    mail: {
      host: "mailpit",
      port: 1025,
      user: "u",
      password: "p",
      secure: true as const,
      fromDomain: "preview.invalid",
    },
    network: "mailnet",
    uiUrl: "https://mail.example.com",
  },
};

const SQLITE_DB: DbSpec = {
  provider: "sqlite",
  path: "/data",
  file: "preview.db",
};

function ctxWithMail(
  mailPart: PreviewMaterializationCtx["mail"] = MAIL.mail
    ? {
        mail: {
          host: "mailpit",
          port: 1025,
          user: "mailpit",
          password: "mailpit",
          fromDomain: "preview.invalid",
        },
      }
    : undefined,
): PreviewMaterializationCtx {
  return {
    traefikNetwork: "sprout-traefik",
    postgres: { pg: PG, network: "sprout-postgres" },
    ...(mailPart ? { mail: mailPart } : {}),
  };
}

describe("resolvePreviewPlan mail", () => {
  test("mail appears in app env with configured values", () => {
    const plan = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
    });
    expect(plan.gatewayEnv).toEqual(
      expect.arrayContaining([
        "MAILHOST=mailpit",
        "MAILPORT=1025",
        "MAILUSER=mailpit",
        "MAILPASSWORD=mailpit",
      ]),
    );
  });

  test("preview.env remaps mail to SMTP_* names", () => {
    const plan = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
      connectionEnv: { MAILHOST: "SMTP_HOST", MAILPORT: "SMTP_PORT" },
    });
    expect(plan.gatewayEnv).toContain("SMTP_HOST=mailpit");
    expect(plan.gatewayEnv).toContain("SMTP_PORT=1025");
    expect(plan.gatewayEnv).not.toContain("MAILHOST=mailpit");
  });

  test("mail works with sqlite and none providers", () => {
    const sqlite = resolvePreviewPlan(ctxWithMail(), {
      spec: SQLITE_DB,
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
    });
    expect(sqlite.gatewayEnv).toContain("MAILHOST=mailpit");

    const none = resolvePreviewPlan(ctxWithMail(), {
      spec: { provider: "none", path: "/data", file: "preview.db" },
      dbName: null,
      slug: "myapp",
      prId: 42,
    });
    expect(none.gatewayEnv).toContain("MAILHOST=mailpit");
  });

  test("mail:none suppresses injection", () => {
    const plan = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
      mail: { mode: "none" },
    });
    expect(plan.gatewayEnv).not.toContain("MAILHOST=mailpit");
    expect(plan.mailboxUrl).toBeUndefined();
    expect(plan.mailFrom).toBeUndefined();
  });

  test("explicit mail:enabled without gateway mail throws", () => {
    expect(() =>
      resolvePreviewPlan(
        { traefikNetwork: "sprout-traefik" },
        {
          spec: defaultDbSpec(),
          dbName: "sprout_myapp_pr42",
          slug: "myapp",
          prId: 42,
          mail: { mode: "enabled" },
        },
      ),
    ).toThrow("mail plan requested without mail config");
  });

  test("mail network joins app and seed networks; unset means no change", () => {
    const withNet = resolvePreviewPlan(
      {
        traefikNetwork: "sprout-traefik",
        postgres: { pg: PG, network: "sprout-postgres" },
        mail: MAIL_FULL.mail,
      },
      {
        spec: defaultDbSpec(),
        dbName: "sprout_myapp_pr42",
        slug: "myapp",
        prId: 42,
      },
    );
    expect(withNet.appNetworks).toEqual([
      "sprout-traefik",
      "sprout-postgres",
      "mailnet",
    ]);
    expect(withNet.seedNetworks).toEqual(["sprout-postgres", "mailnet"]);
    expect(withNet.mailboxUrl).toBe("https://mail.example.com");
    expect(withNet.gatewayEnv).toContain("MAILSECURE=true");
    expect(withNet.gatewayEnv).toContain(
      "MAILUIURL=https://mail.example.com",
    );

    const withoutNet = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
    });
    expect(withoutNet.appNetworks).toEqual([
      "sprout-traefik",
      "sprout-postgres",
    ]);
    expect(withoutNet.mailboxUrl).toBeUndefined();
  });

  test("MAILFROM derives per preview and remaps", () => {
    const plan = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
    });
    expect(plan.gatewayEnv).toContain("MAILFROM=myapp-pr42@preview.invalid");
    expect(plan.gatewayEnv).toContain("MAILFROMNAME=myapp PR 42");
    expect(plan.gatewayEnv).toContain("MAILREPLYTO=myapp-pr42@preview.invalid");
    expect(plan.mailFrom).toBe("myapp-pr42@preview.invalid");
    expect(plan.mailFromName).toBe("myapp PR 42");

    const remapped = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
      connectionEnv: { MAILFROM: "SMTP_FROM" },
    });
    expect(remapped.gatewayEnv).toContain("SMTP_FROM=myapp-pr42@preview.invalid");
    expect(remapped.gatewayEnv).not.toContain("MAILFROM=myapp-pr42@preview.invalid");
  });

  test("mail.from override resolves per preview", () => {
    const plan = resolvePreviewPlan(ctxWithMail(), {
      spec: defaultDbSpec(),
      dbName: "sprout_myapp_pr42",
      slug: "myapp",
      prId: 42,
      mail: { mode: "enabled", from: "noreply+{pr_id}@preview.invalid" },
    });
    expect(plan.gatewayEnv).toContain("MAILFROM=noreply+42@preview.invalid");
    expect(plan.mailFrom).toBe("noreply+42@preview.invalid");
  });
});
