import {
  dbSpecIssueMessage,
  isServicePort,
  mailSpecIssueMessage,
  normalizeDbSpec,
  parseDbSpec,
  parseMailSpec,
  parsePreviewEnvForProvider,
  parseServiceEnvMap,
  requiresDatabase,
  resolveHealthSpec,
  seedRequiresDatabaseMessage,
  validateHostname,
  type DbSpec,
  type HealthRequest,
  type MailSpec,
  type PreviewEnvMap,
  type PreviewServiceSpec,
} from "@sprout/preview-env";
import { t } from "elysia";
import { parseResetMarkerToken } from "@sprout/preview-db";
import type { AuthContext } from "../auth/middleware.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import {
  mailNotConfiguredDetail,
  postgresNotConfiguredDetail,
} from "../config.ts";
import {
  previewSnapshotFromRow,
  teardownPreview,
  setResetRequestMarker,
  type LifecycleDeps,
  type PreviewSnapshot,
} from "../preview/lifecycle.ts";
import type { MailPresentation } from "../preview/snapshot.ts";
import {
  resolvePreviewPlan,
  type PreviewMaterializationCtx,
} from "../preview/runtime.ts";
import {
  acceptAsyncDeploy,
  runAsyncDeploy,
} from "../preview/async-deploy.ts";
import {
  validatePreviewIdentity,
  validateServiceName,
} from "../preview-db/names.ts";
import { mapResult, requirePreviewTarget, requireReadablePreview } from "./result-map.ts";

const healthBody = t.Object({
  path: t.String({ minLength: 1 }),
  interval: t.String({ minLength: 1 }),
  timeout: t.String({ minLength: 1 }),
  expect: t.Number(),
});

const serviceBody = t.Object({
  name: t.String({ minLength: 1 }),
  image: t.String({ minLength: 1 }),
  hostname: t.Optional(t.String({ minLength: 1 })),
  path: t.Optional(t.String({ minLength: 1 })),
  port: t.Optional(t.Integer({ minimum: 1, maximum: 65535 })),
  env: t.Optional(t.Record(t.String(), t.String())),
});

const MAX_SEED_ENV = 16;
const MAX_SEED_ARG = 16;
const MAX_APP_ENV = 32;
const MAX_SERVICES = 8;

const dbBody = t.Object({
  provider: t.Optional(t.String()),
  path: t.Optional(t.String()),
  file: t.Optional(t.String()),
});

const mailBody = t.Union([
  t.String(),
  t.Object({
    mode: t.Optional(t.String()),
    from: t.Optional(t.String()),
  }),
]);

export const deployBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
  hostname: t.String({ minLength: 1 }),
  app_image: t.String({ minLength: 1 }),
  env: t.Optional(t.Record(t.String(), t.String())),
  db: t.Optional(dbBody),
  mail: t.Optional(mailBody),
  health: t.Optional(healthBody),
  seed_image: t.Optional(t.String({ minLength: 1 })),
  seed_env: t.Optional(t.Array(t.String())),
  seed_arg: t.Optional(t.Array(t.String())),
  app_env: t.Optional(t.Array(t.String())),
  services: t.Optional(t.Array(serviceBody)),
  reseed: t.Optional(t.Boolean()),
});

export const teardownBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
});

export const resetMarkerBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  marker: t.String({ minLength: 1, maxLength: 256 }),
});

export const previewQuery = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.String({ minLength: 1 }),
});

export type DeployBody = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  hostname: string;
  app_image: string;
  env?: Record<string, string>;
  db?: { provider?: string; path?: string; file?: string };
  mail?: string | { mode?: string; from?: string };
  health?: HealthRequest;
  seed_image?: string;
  seed_env?: string[];
  seed_arg?: string[];
  app_env?: string[];
  services?: PreviewServiceSpec[];
  reseed?: boolean;
};

export type DeployDbAndEnv = {
  spec: DbSpec;
  connectionEnv?: PreviewEnvMap;
  mail?: MailSpec;
};

/**
 * One validation pipeline for db + env: parse the db block, enforce the
 * postgres gate, then parse and provider-scope the env map. A single call
 * site maps the result to a status, so the wire codes stay in one place.
 *
 * Postgres presence lives only on the materialization context; the gate
 * reads it from there so deploy has a single source of truth.
 */
export function resolveDeployDbAndEnv(
  body: Pick<DeployBody, "db" | "env" | "mail">,
  materialization: PreviewMaterializationCtx,
  repo: string,
):
  | { ok: true; value: DeployDbAndEnv }
  | { ok: false; status: number; error: string; detail?: string } {
  const parsed = parseDbSpec(body.db);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 422,
      error: "invalid_db",
      detail: dbSpecIssueMessage(parsed.issue),
    };
  }
  const spec = normalizeDbSpec(parsed.value);
  if (spec.provider === "postgres" && !materialization.postgres) {
    return {
      ok: false,
      status: 500,
      error: "postgres_not_configured",
      detail: postgresNotConfiguredDetail(undefined, repo),
    };
  }
  const mailParsed = parseMailSpec(body.mail);
  if (!mailParsed.ok) {
    return {
      ok: false,
      status: 422,
      error: "invalid_mail",
      detail: mailSpecIssueMessage(mailParsed.issue),
    };
  }
  const mail = mailParsed.value;
  if (mail?.mode === "enabled" && !materialization.mail) {
    return {
      ok: false,
      status: 500,
      error: "mail_not_configured",
      detail: mailNotConfiguredDetail(repo),
    };
  }
  const connectionEnv = parsePreviewEnvForProvider(body.env, spec.provider);
  if (!connectionEnv.ok) {
    if (connectionEnv.issue.code === "env_requires_provider") {
      return {
        ok: false,
        status: 422,
        error: "invalid_env_for_provider",
        detail: `preview.env.${connectionEnv.issue.key} requires db.provider ${connectionEnv.issue.home}`,
      };
    }
    if (connectionEnv.issue.code === "empty_env_target") {
      return { ok: false, status: 422, error: "invalid_env_target" };
    }
    return { ok: false, status: 422, error: connectionEnv.issue.code };
  }
  return { ok: true, value: { spec, connectionEnv: connectionEnv.value, mail } };
}

function validateKvEnvEntries(
  entries: string[],
  opts: { max: number; tooMany: string; invalid: string },
): { ok: true } | { ok: false; error: string } {
  if (entries.length > opts.max) {
    return { ok: false, error: opts.tooMany };
  }
  for (const entry of entries) {
    if (entry.indexOf("=") <= 0) {
      return { ok: false, error: opts.invalid };
    }
  }
  return { ok: true };
}

export function resolveSeedRequest(
  body: Pick<
    DeployBody,
    "seed_image" | "seed_env" | "seed_arg" | "health" | "reseed"
  >,
  provider: DbSpec["provider"],
):
  | { ok: true; value: SeedImageSpec | undefined }
  | { ok: false; error: string; detail?: string } {
  const seedImage = body.seed_image?.trim();
  const seedEnv = body.seed_env ?? [];
  const seedArg = body.seed_arg ?? [];

  // None previews have no database for a seed job to populate.
  if (
    !requiresDatabase(provider) &&
    (seedImage || body.reseed === true || seedEnv.length > 0 || seedArg.length > 0)
  ) {
    return {
      ok: false,
      error: "seed_requires_database",
      detail: seedRequiresDatabaseMessage(),
    };
  }

  if (!seedImage) {
    if (body.reseed) {
      return { ok: false, error: "seed_image_required_for_reseed" };
    }
    if (seedEnv.length > 0 || seedArg.length > 0) {
      return { ok: false, error: "seed_image_required_for_seed_options" };
    }
    return { ok: true, value: undefined };
  }
  if (!body.health) {
    return { ok: false, error: "health_required_for_seed" };
  }
  if (seedArg.length > MAX_SEED_ARG) {
    return { ok: false, error: "too_many_seed_arg" };
  }
  const envCheck = validateKvEnvEntries(seedEnv, {
    max: MAX_SEED_ENV,
    tooMany: "too_many_seed_env",
    invalid: "invalid_seed_env",
  });
  if (!envCheck.ok) return envCheck;
  return {
    ok: true,
    value: {
      image: seedImage,
      env: seedEnv,
      args: seedArg,
    },
  };
}

export function resolveAppEnvRequest(
  body: Pick<DeployBody, "app_env">,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const appEnv = body.app_env ?? [];
  const check = validateKvEnvEntries(appEnv, {
    max: MAX_APP_ENV,
    tooMany: "too_many_app_env",
    invalid: "invalid_app_env",
  });
  if (!check.ok) return check;
  return { ok: true, value: appEnv };
}

export function resolveServicesRequest(
  body: Pick<DeployBody, "services">,
):
  | { ok: true; value: PreviewServiceSpec[] | undefined }
  | { ok: false; error: string } {
  if (body.services === undefined) {
    return { ok: true, value: undefined };
  }
  const raw = body.services;
  if (raw.length > MAX_SERVICES) {
    return { ok: false, error: "too_many_services" };
  }
  const seen = new Set<string>();
  const out: PreviewServiceSpec[] = [];
  for (const entry of raw) {
    const name = entry.name.trim();
    const image = entry.image.trim();
    if (!name || !image) {
      return { ok: false, error: "invalid_service" };
    }
    if (validateServiceName(name)) {
      return { ok: false, error: "invalid_service_name" };
    }
    if (seen.has(name)) {
      return { ok: false, error: "duplicate_service_name" };
    }
    seen.add(name);
    const hostname = entry.hostname?.trim();
    const path = entry.path?.trim();
    if (path != null && path !== "" && !path.startsWith("/")) {
      return { ok: false, error: "invalid_service_path" };
    }
    const spec: PreviewServiceSpec = { name, image };
    if (hostname) {
      if (!validateHostname(hostname).ok) {
        return { ok: false, error: "invalid_service_hostname" };
      }
      spec.hostname = hostname;
    }
    if (path) spec.path = path;
    if (entry.port !== undefined) {
      if (!isServicePort(entry.port)) {
        return { ok: false, error: "invalid_service_port" };
      }
      spec.port = entry.port;
    }
    const parsedEnv = parseServiceEnvMap(entry.env);
    if (!parsedEnv.ok) {
      return { ok: false, error: "invalid_service_env" };
    }
    if (parsedEnv.value !== undefined) spec.env = parsedEnv.value;
    out.push(spec);
  }
  return { ok: true, value: out };
}

export type TeardownBody = {
  canonical_repo_id: string;
  pr_id: number;
};

export type ResetMarkerBody = {
  canonical_repo_id: string;
  pr_id: number;
  marker: string;
};

export type PreviewQuery = {
  canonical_repo_id: string;
  pr_id: string;
};

export function deploy(
  deps: LifecycleDeps & {
    materialization: PreviewMaterializationCtx;
  },
) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: DeployBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }): Promise<PreviewSnapshot | { error: string; detail?: string }> => {
    const target = requirePreviewTarget(
      auth,
      body.canonical_repo_id,
      body.pr_id,
    );
    if (!target.ok) return mapResult(target, set);
    const identityErr = validatePreviewIdentity(body.slug, target.value.prId);
    if (identityErr) {
      set.status = 422;
      return { error: identityErr };
    }
    const hostname = body.hostname.trim();
    if (!validateHostname(hostname).ok) {
      set.status = 422;
      return { error: "invalid_hostname" };
    }
    const dbAndEnv = resolveDeployDbAndEnv(body, deps.materialization, target.value.repo);
    if (!dbAndEnv.ok) {
      set.status = dbAndEnv.status;
      return dbAndEnv.detail
        ? { error: dbAndEnv.error, detail: dbAndEnv.detail }
        : { error: dbAndEnv.error };
    }
    const plan = resolvePreviewPlan(deps.materialization, {
      spec: dbAndEnv.value.spec,
      slug: body.slug,
      prId: target.value.prId,
      connectionEnv: dbAndEnv.value.connectionEnv,
      mail: dbAndEnv.value.mail,
    });
    const seed = resolveSeedRequest(body, dbAndEnv.value.spec.provider);
    if (!seed.ok) {
      set.status = 422;
      return seed.detail != null
        ? { error: seed.error, detail: seed.detail }
        : { error: seed.error };
    }
    const appEnv = resolveAppEnvRequest(body);
    if (!appEnv.ok) {
      set.status = 422;
      return { error: appEnv.error };
    }
    const services = resolveServicesRequest(body);
    if (!services.ok) {
      set.status = 422;
      return { error: services.error };
    }
    const health = resolveHealthSpec(body.health);
    if (!health.ok) {
      set.status = 422;
      return { error: health.issue.code };
    }

    const input = {
      repo: target.value.repo,
      prId: target.value.prId,
      slug: body.slug,
      hostname,
      appImage: body.app_image,
      health: health.value,
      seed: seed.value,
      appEnv: appEnv.value,
      services: services.value,
      plan,
      reseed: body.reseed === true,
    };

    // 202 before pull/health/seed so Cloudflare (~100s) cannot kill the POST.
    const accepted = await acceptAsyncDeploy(deps, input);
    if (!accepted.ok) return mapResult(accepted, set);

    set.status = 202;
    if (accepted.value.launch) {
      void runAsyncDeploy(deps, input);
    }
    return accepted.value.snapshot;
  };
}

export function getPreview(
  deps: LifecycleDeps,
  mail?: MailPresentation,
) {
  return async ({
    query,
    auth,
    set,
  }: {
    query: PreviewQuery;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    return mapResult(
      await requireReadablePreview(
        deps,
        auth,
        query.canonical_repo_id,
        query.pr_id,
        mail,
      ),
      set,
    );
  };
}

export function teardown(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: TeardownBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    const target = requirePreviewTarget(
      auth,
      body.canonical_repo_id,
      body.pr_id,
    );
    if (!target.ok) return mapResult(target, set);

    return mapResult(
      await teardownPreview(deps, {
        repo: target.value.repo,
        prId: target.value.prId,
      }),
      set,
    );
  };
}

export function setResetMarker(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: ResetMarkerBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    const target = requirePreviewTarget(
      auth,
      body.canonical_repo_id,
      body.pr_id,
    );
    if (!target.ok) return mapResult(target, set);
    const marker = parseResetMarkerToken(body.marker);
    if (!marker) {
      set.status = 422;
      return { error: "invalid_reset_marker" };
    }
    const stored = await setResetRequestMarker(
      deps.db,
      target.value.repo,
      target.value.prId,
      marker,
    );
    if (!stored.ok) return mapResult(stored, set);
    return previewSnapshotFromRow(stored.value);
  };
}
