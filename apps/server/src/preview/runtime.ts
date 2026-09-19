import {
  mailIntent,
  requiresDatabase,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type MailSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
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
  if (mailIntent(input.mail) === "off") {
    return { env: [], networks: [] };
  }
  const configured = ctx.mail;
  // Explicit-enabled without config is rejected by the deploy gate, so
  // reaching here means a new caller skipped it: fail loudly like the
  // postgres branch instead of silently deploying without mail.
  if (mailIntent(input.mail) === "required" && !configured) {
    throw new Error("mail plan requested without mail config");
  }
  // Omitted mail is opportunistic: inject when configured, skip when not.
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
  const mailFrom =
    mail.mailFrom !== undefined ? { mailFrom: mail.mailFrom } : {};
  // The mail merge is identical in every branch: app containers always join
  // the mail network when configured so MAILHOST resolves. Seed jobs join it
  // too whenever a seed can run; provider none rejects seeds, so its empty
  // seedNetworks stay empty instead of widening isolation for no benefit.
  if (input.spec.provider === "none") {
    return {
      provider: "none",
      dbName,
      gatewayEnv: [...mail.env],
      volumes: [],
      appNetworks: [ctx.traefikNetwork, ...mail.networks],
      seedNetworks: [],
      ...mailFrom,
    };
  }
  if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    return {
      provider: "sqlite",
      dbName,
      gatewayEnv: [
        `${target}=${sqliteDatabaseUrl(input.spec.path, input.spec.file)}`,
        ...mail.env,
      ],
      volumes: [`${sqliteVolumeName(input.slug, input.prId)}:${input.spec.path}`],
      appNetworks: [ctx.traefikNetwork, ...mail.networks],
      // Seed needs no postgres data; traefik is the network that always exists.
      seedNetworks: [ctx.traefikNetwork, ...mail.networks],
      ...mailFrom,
    };
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
  return {
    provider: "postgres",
    dbName,
    gatewayEnv: [
      ...pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
      ...mail.env,
    ],
    volumes: [],
    appNetworks: [ctx.traefikNetwork, postgres.network, ...mail.networks],
    seedNetworks: [postgres.network, ...mail.networks],
    ...mailFrom,
  };
}
