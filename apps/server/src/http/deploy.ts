import {
  dbSpecIssueMessage,
  isServicePort,
  labelIssueMessage,
  mailIntent,
  mailSpecIssueMessage,
  normalizeDbSpec,
  parseDbSpec,
  parseLabelMap,
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
  type PreviewLabels,
  type PreviewServiceSpec,
} from "@sprout/preview-env";
import { t } from "elysia";
import { parseResetMarkerToken } from "@sprout/preview-db";
import type { AuthContext } from "../auth/middleware.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import {
  checkReservedKeys,
  isReservedPreviewLabel,
} from "../app-deployment/labels.ts";
import {
  appGatewayKeys,
  serviceGatewayKeys,
} from "../app-deployment/workload-labels.ts";
import {
  mailNotConfiguredDetail,
  postgresNotConfiguredDetail,
} from "../config.ts";
import {
  teardownPreview,
  setResetRequestMarker,
  type LifecycleDeps,
  type PreviewSnapshot,
} from "../preview/lifecycle.ts";
import { presentPreviewSnapshot, previewSnapshotFromRow } from "../preview/snapshot.ts";
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
import { mapResult, requirePreviewTarget, requireReadablePreviewRow } from "./result-map.ts";

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
  labels: t.Optional(t.Record(t.String(), t.String())),
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
  labels: t.Optional(t.Record(t.String(), t.String())),
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
  labels?: PreviewLabels;
  reseed?: boolean;
};

export type DeploySpecs = {
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
export function resolveDeploySpecs(
  body: Pick<DeployBody, "db" | "env" | "mail">,
  materialization: PreviewMaterializationCtx,
  repo: string,
):
  | { ok: true; value: DeploySpecs }
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
  // Mail intent is tri-state: omitted means opportunistic (inject when the
  // gateway configures mail, silently skip when not); explicit enabled
  // means required (fail when unconfigured); none means off. This gate is
  // the single place that maps required-without-config to a status; the
  // plan layer treats any unconfigured gateway as skip.
  if (mailIntent(mail) === "required" && !materialization.mail) {
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
  | { ok: false; error: string; detail?: string } {
  if (body.services === undefined) {
    return { ok: true, value: undefined };
  }
  const raw = body.services;
  if (raw.length > MAX_SERVICES) {
    return { ok: false, error: "too_many_services" };
  }
  const seen = new Set<string>();
  const out: PreviewServiceSpec[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index]!;
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
    const parsedLabels = parseLabelMap(entry.labels);
    if (!parsedLabels.ok) {
      return {
        ok: false,
        error: "invalid_service_labels",
        detail: labelIssueMessage(
          `preview.services[${index}].labels`,
          parsedLabels.issue,
        ),
      };
    }
    if (parsedLabels.value !== undefined) spec.labels = parsedLabels.value;
    out.push(spec);
  }
  return { ok: true, value: out };
}

export function resolvePreviewLabelsRequest(
  body: Pick<DeployBody, "labels">,
):
  | { ok: true; value: PreviewLabels | undefined }
  | { ok: false; error: string; detail?: string } {
  if (body.labels === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = parseLabelMap(body.labels);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "invalid_labels",
      detail: labelIssueMessage("preview.labels", parsed.issue),
    };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Fail fast when an adopter label would silently override a gateway-owned
 * Traefik label. The reserved key sets come from the same workload-labels
 * seam the containers materialize from, so validation cannot drift from
 * the gateway's TLS and forwardAuth policy.
 */
export function resolveLabelCollisions(input: {
  slug: string;
  prId: number;
  labels: PreviewLabels | undefined;
  services: PreviewServiceSpec[] | undefined;
  materialization: PreviewMaterializationCtx;
}): { ok: true } | { ok: false; error: string; detail?: string } {
  try {
    checkReservedKeys(
      appGatewayKeys(input.slug, input.prId, input.materialization),
      input.labels,
    );
    (input.services ?? []).forEach((service, index) => {
      checkReservedKeys(
        serviceGatewayKeys(
          input.slug,
          input.prId,
          service,
          input.materialization,
        ),
        input.labels,
        {
          labels: service.labels,
          index,
        },
      );
    });
  } catch (err) {
    if (isReservedPreviewLabel(err)) {
      return {
        ok: false,
        error: "reserved_preview_label",
        detail: err.message,
      };
    }
    throw err;
  }
  return { ok: true };
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
    const deploySpecs = resolveDeploySpecs(body, deps.materialization, target.value.repo);
    if (!deploySpecs.ok) {
      set.status = deploySpecs.status;
      return deploySpecs.detail
        ? { error: deploySpecs.error, detail: deploySpecs.detail }
        : { error: deploySpecs.error };
    }
    const plan = resolvePreviewPlan(deps.materialization, {
      spec: deploySpecs.value.spec,
      slug: body.slug,
      prId: target.value.prId,
      connectionEnv: deploySpecs.value.connectionEnv,
      mail: deploySpecs.value.mail,
    });
    const seed = resolveSeedRequest(body, deploySpecs.value.spec.provider);
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
      return services.detail != null
        ? { error: services.error, detail: services.detail }
        : { error: services.error };
    }
    const labels = resolvePreviewLabelsRequest(body);
    if (!labels.ok) {
      set.status = 422;
      return labels.detail != null
        ? { error: labels.error, detail: labels.detail }
        : { error: labels.error };
    }
    const collisions = resolveLabelCollisions({
      slug: body.slug,
      prId: target.value.prId,
      labels: labels.value,
      services: services.value,
      materialization: deps.materialization,
    });
    if (!collisions.ok) {
      set.status = 422;
      return collisions.detail != null
        ? { error: collisions.error, detail: collisions.detail }
        : { error: collisions.error };
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
      ...(labels.value !== undefined ? { labels: labels.value } : {}),
      plan,
      reseed: body.reseed === true,
    };

    // 202 before pull/health/seed so Cloudflare (~100s) cannot kill the POST.
    // Mailbox presentation applies once at the edge; lifecycle snapshots
    // carry only stored mail_from.
    const accepted = await acceptAsyncDeploy(deps, input);
    if (!accepted.ok) return mapResult(accepted, set);

    set.status = 202;
    if (accepted.value.launch) {
      void runAsyncDeploy(deps, input);
    }
    return presentPreviewSnapshot(
      accepted.value.row,
      deps.materialization.mail?.uiUrl,
    );
  };
}

export function getPreview(
  deps: LifecycleDeps,
  mailboxUrl?: string,
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
    const result = await requireReadablePreviewRow(
      deps,
      auth,
      query.canonical_repo_id,
      query.pr_id,
    );
    if (!result.ok) return mapResult(result, set);
    return presentPreviewSnapshot(result.value, mailboxUrl);
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
