import {
  mailIntent,
  requiresDatabase,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type MailSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import type {
  TraefikForwardAuth,
  TraefikTls,
} from "../app-deployment/labels.ts";
import { mailConnectionEnv } from "../app-deployment/mail-env.ts";
import type { MailConfig } from "../config.ts";
import { pgConnectionEnv, type AppDeployPg } from "../app-deployment/pg-env.ts";
import { previewDbName } from "../preview-db/names.ts";
import { sqliteVolumeName } from "./naming.ts";

/**
 * Materialization inputs. Postgres is present only when the gateway
 * configures it, so a postgres plan on a sqlite-only gateway fails by type.
 * Mail is never provisioned: presence only injects env and joins a network.
 */
export type PreviewMaterializationCtx = {
  traefikNetwork: string;
  postgres?: {
    pg: AppDeployPg;
    network: string;
  };
  mail?: MailConfig;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

/**
 * Concrete materialization resolved once at the deploy boundary.
 * Lifecycle and app-deployment consume the plan; raw DbSpec never travels.
 * dbName is the owned backend resource name, null when there is none.
 * The plan carries only container inputs; mailbox presentation stays at the
 * route layer and travels as a separate snapshot argument.
 */
export type PreviewDbPlan = {
  provider: DbProvider;
  dbName: string | null;
  gatewayEnv: string[];
  volumes: string[];
  appNetworks: string[];
  seedNetworks: string[];
  mailFrom?: string;
};

function resolveMailPart(
  ctx: PreviewMaterializationCtx,
  input: {
    mail?: MailSpec;
    connectionEnv?: PreviewEnvMap;
    slug: string;
    prId: number;
  },
): { env: string[]; networks: string[]; mailFrom?: string } {
  const intent = mailIntent(input.mail);
  if (intent === "off") {
    return { env: [], networks: [] };
  }
  const configured = ctx.mail;
  // The deploy gate owns the required-without-config verdict
  // (mail_not_configured); any unconfigured gateway skips here so this
  // layer stays total and never re-checks intent.
  if (!configured) return { env: [], networks: [] };
  const { env, resolved } = mailConnectionEnv(
    configured,
    {
      slug: input.slug,
      prId: input.prId,
      ...(input.mail?.from !== undefined ? { from: input.mail.from } : {}),
    },
    input.connectionEnv,
  );
  const networks = configured.network ? [configured.network] : [];
  return {
    env,
    networks,
    mailFrom: resolved.address,
  };
}

export function resolvePreviewPlan(
  ctx: PreviewMaterializationCtx,
  input: {
    spec: DbSpec;
    slug: string;
    prId: number;
    connectionEnv?: PreviewEnvMap;
    mail?: MailSpec;
    /** Test override; deploy omits it so identity resolves in one place. */
    dbName?: string | null;
  },
): PreviewDbPlan {
  const dbName =
    input.dbName !== undefined
      ? input.dbName
      : requiresDatabase(input.spec.provider)
        ? previewDbName(input.slug, input.prId)
        : null;
  const mail = resolveMailPart(ctx, input);
  // Provider branches below build the mail-free base plan; the single
  // overlay after them appends mail env, joins the mail network, and sets
  // mailFrom. Seed jobs join the mail network whenever a seed can run;
  // provider none rejects seeds, so its empty seedNetworks stay empty
  // instead of widening isolation for no benefit.
  const seedJoinsMailNet = input.spec.provider !== "none";
  const withMail = (
    base: Omit<PreviewDbPlan, "mailFrom">,
  ): PreviewDbPlan => ({
    ...base,
    gatewayEnv: [...base.gatewayEnv, ...mail.env],
    appNetworks: [...base.appNetworks, ...mail.networks],
    seedNetworks: seedJoinsMailNet
      ? [...base.seedNetworks, ...mail.networks]
      : base.seedNetworks,
    ...(mail.mailFrom !== undefined ? { mailFrom: mail.mailFrom } : {}),
  });
  if (input.spec.provider === "none") {
    return withMail({
      provider: "none",
      dbName,
      gatewayEnv: [],
      volumes: [],
      appNetworks: [ctx.traefikNetwork],
      seedNetworks: [],
    });
  }
  if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    return withMail({
      provider: "sqlite",
      dbName,
      gatewayEnv: [
        `${target}=${sqliteDatabaseUrl(input.spec.path, input.spec.file)}`,
      ],
      volumes: [`${sqliteVolumeName(input.slug, input.prId)}:${input.spec.path}`],
      appNetworks: [ctx.traefikNetwork],
      // Seed needs no postgres data; traefik is the network that always exists.
      seedNetworks: [ctx.traefikNetwork],
    });
  }
  const postgres = ctx.postgres;
  if (!postgres) {
    throw new Error(
      `postgres plan requested for ${dbName} without postgres config`,
    );
  }
  if (dbName == null) {
    throw new Error("postgres plan requested without a database name");
  }
  return withMail({
    provider: "postgres",
    dbName,
    gatewayEnv: [
      ...pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
    ],
    volumes: [],
    appNetworks: [ctx.traefikNetwork, postgres.network],
    seedNetworks: [postgres.network],
  });
}
