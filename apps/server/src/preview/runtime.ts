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
): MailPart {
  if (mailIntent(input.mail) === "off") {
    return { env: [], networks: [] };
  }
  const configured = ctx.mail;
  // Omitted mail is opportunistic (inject when configured, skip when not);
  // explicit-enabled without config is rejected by the deploy gate, so an
  // unconfigured gateway here always means skip, never throw.
  if (!configured) return { env: [], networks: [] };
  const identity = {
    slug: input.slug,
    prId: input.prId,
    ...(input.mail?.from !== undefined ? { fromTemplate: input.mail.from } : {}),
  };
  const { env, resolved } = mailConnectionEnv(
    configured,
    identity,
    input.connectionEnv,
  );
  const networks = configured.network ? [configured.network] : [];
  return {
    env,
    networks,
    mailFrom: resolved.address,
  };
}

type MailPart = {
  env: string[];
  networks: string[];
  mailFrom?: string;
};

/**
 * Mail merge is orthogonal to the provider branch. App containers always join
 * the mail network when configured so MAILHOST resolves. Seed jobs join too
 * whenever a seed can run (any provider except none, which rejects seeds);
 * none never runs a seed, so joining would only widen isolation for no benefit.
 */
function withMail(
  base: Omit<PreviewDbPlan, "mailFrom">,
  mail: MailPart,
  seedable: boolean,
): PreviewDbPlan {
  return {
    ...base,
    gatewayEnv: [...base.gatewayEnv, ...mail.env],
    appNetworks:
      mail.networks.length > 0
        ? [...base.appNetworks, ...mail.networks]
        : base.appNetworks,
    seedNetworks:
      mail.networks.length > 0 && seedable
        ? [...base.seedNetworks, ...mail.networks]
        : base.seedNetworks,
    ...(mail.mailFrom !== undefined ? { mailFrom: mail.mailFrom } : {}),
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
  if (input.spec.provider === "none") {
    return withMail(
      {
        provider: "none",
        dbName,
        gatewayEnv: [],
        volumes: [],
        appNetworks: [ctx.traefikNetwork],
        seedNetworks: [],
      },
      mailPart,
      false,
    );
  }
  if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    return withMail(
      {
        provider: "sqlite",
        dbName,
        gatewayEnv: [
          `${target}=${sqliteDatabaseUrl(input.spec.path, input.spec.file)}`,
        ],
        volumes: [`${sqliteVolumeName(input.slug, input.prId)}:${input.spec.path}`],
        appNetworks: [ctx.traefikNetwork],
        // Seed needs no postgres data; traefik is the network that always exists.
        seedNetworks: [ctx.traefikNetwork],
      },
      mailPart,
      true,
    );
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
  return withMail(
    {
      provider: "postgres",
      dbName,
      gatewayEnv: pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
      volumes: [],
      appNetworks: [ctx.traefikNetwork, postgres.network],
      seedNetworks: [postgres.network],
    },
    mailPart,
    true,
  );
}
