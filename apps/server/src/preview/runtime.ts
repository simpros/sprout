import {
  deriveMailFromName,
  requiresDatabase,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type MailSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import {
  mailConnectionEnv,
  resolveMailFromAddress,
  type MaterializationMail,
} from "../app-deployment/mail-env.ts";
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
  mail?: MaterializationMail;
};

/**
 * Concrete materialization resolved once at the deploy boundary.
 * Lifecycle and app-deployment consume the plan; raw DbSpec never travels.
 * dbName is the owned backend resource name, null when there is none.
 */
export type PreviewDbPlan = {
  provider: DbProvider;
  dbName: string | null;
  gatewayEnv: string[];
  volumes: string[];
  appNetworks: string[];
  seedNetworks: string[];
  mailboxUrl?: string;
  mailFrom?: string;
  mailFromName?: string;
};

function resolveMailPart(
  ctx: PreviewMaterializationCtx,
  input: {
    mail?: MailSpec;
    connectionEnv?: PreviewEnvMap;
    slug: string;
    prId: number;
  },
): {
  env: string[];
  networks: string[];
  mailboxUrl?: string;
  mailFrom?: string;
  mailFromName?: string;
} {
  if (input.mail?.mode === "none") return { env: [], networks: [] };
  const configured = ctx.mail;
  if (!configured) {
    if (input.mail === undefined) return { env: [], networks: [] };
    throw new Error("mail plan requested without mail config");
  }
  const identity = {
    slug: input.slug,
    prId: input.prId,
    ...(input.mail?.from !== undefined ? { fromTemplate: input.mail.from } : {}),
  };
  const env = mailConnectionEnv(configured, input.connectionEnv, identity);
  const networks = configured.network ? [configured.network] : [];
  const mailboxUrl = configured.uiUrl;
  const mailFrom = resolveMailFromAddress(configured, identity);
  return {
    env,
    networks,
    ...(mailboxUrl !== undefined ? { mailboxUrl } : {}),
    mailFrom,
    mailFromName: deriveMailFromName(identity.slug, identity.prId),
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
  const mailPart = resolveMailPart(ctx, input);
  const withMail = (
    base: Omit<PreviewDbPlan, "mailboxUrl" | "mailFrom" | "mailFromName">,
  ): PreviewDbPlan => ({
    ...base,
    gatewayEnv: [...base.gatewayEnv, ...mailPart.env],
    appNetworks:
      mailPart.networks.length > 0
        ? [...base.appNetworks, ...mailPart.networks]
        : base.appNetworks,
    seedNetworks:
      mailPart.networks.length > 0 && base.seedNetworks.length > 0
        ? [...base.seedNetworks, ...mailPart.networks]
        : base.seedNetworks,
    ...(mailPart.mailboxUrl !== undefined
      ? { mailboxUrl: mailPart.mailboxUrl }
      : {}),
    ...(mailPart.mailFrom !== undefined ? { mailFrom: mailPart.mailFrom } : {}),
    ...(mailPart.mailFromName !== undefined
      ? { mailFromName: mailPart.mailFromName }
      : {}),
  });
  if (input.spec.provider === "none") {
    return withMail({
      provider: "none",
      dbName,
      gatewayEnv: [],
      volumes: [],
      appNetworks: [ctx.traefikNetwork],
      // Seed is rejected for none, so no seed network ever runs.
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
    gatewayEnv: pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
    volumes: [],
    appNetworks: [ctx.traefikNetwork, postgres.network],
    seedNetworks: [postgres.network],
  });
}
