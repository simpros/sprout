import {
  isMailEnabled,
  requiresDatabase,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type MailSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import {
  mailConnectionEnv,
  resolveMailIdentity,
} from "../app-deployment/mail-env.ts";
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
): {
  env: string[];
  networks: string[];
  mailFrom?: string;
} {
  if (input.mail !== undefined && !isMailEnabled(input.mail)) {
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
  const resolved = resolveMailIdentity(configured, identity);
  const env = mailConnectionEnv(configured, input.connectionEnv, resolved);
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
  const mailPart = resolveMailPart(ctx, input);
  // Provider branches build the mail-free base; the mail merge applies once
  // here, orthogonal to the provider, so the network guards read in one place.
  let base: Omit<PreviewDbPlan, "mailFrom">;
  if (input.spec.provider === "none") {
    base = {
      provider: "none",
      dbName,
      gatewayEnv: [],
      volumes: [],
      appNetworks: [ctx.traefikNetwork],
      // Seed is rejected for none, so no seed network ever runs.
      seedNetworks: [],
    };
  } else if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    base = {
      provider: "sqlite",
      dbName,
      gatewayEnv: [
        `${target}=${sqliteDatabaseUrl(input.spec.path, input.spec.file)}`,
      ],
      volumes: [`${sqliteVolumeName(input.slug, input.prId)}:${input.spec.path}`],
      appNetworks: [ctx.traefikNetwork],
      // Seed needs no postgres data; traefik is the network that always exists.
      seedNetworks: [ctx.traefikNetwork],
    };
  } else {
    const postgres = ctx.postgres;
    if (!postgres) {
      throw new Error(
        `postgres plan requested for ${dbName} without postgres config`,
      );
    }
    if (dbName == null) {
      throw new Error("postgres plan requested without a database name");
    }
    base = {
      provider: "postgres",
      dbName,
      gatewayEnv: pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
      volumes: [],
      appNetworks: [ctx.traefikNetwork, postgres.network],
      seedNetworks: [postgres.network],
    };
  }
  return {
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
    ...(mailPart.mailFrom !== undefined ? { mailFrom: mailPart.mailFrom } : {}),
  };
}
