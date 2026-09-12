import {
  parsePreviewEnvMap,
  resolveHealthSpec,
  validateHostname,
  type HealthRequest,
} from "@sprout/preview-env";
import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import type { PreviewServiceSpec } from "../app-deployment/ops.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import {
  teardownPreview,
  type LifecycleDeps,
  type PreviewSnapshot,
} from "../preview/lifecycle.ts";
import {
  acceptAsyncDeploy,
  runAsyncDeploy,
} from "../preview/async-deploy.ts";
import {
  validatePrId,
  validatePreviewIdentity,
  validateServiceName,
} from "../preview-db/names.ts";
import { mapResult, requireReadablePreview, resolveRepo } from "./result-map.ts";

export type { LifecycleDeps };

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
});

const MAX_SEED_ENV = 16;
const MAX_SEED_ARG = 16;
const MAX_APP_ENV = 32;
const MAX_SERVICES = 8;

export const deployBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
  hostname: t.String({ minLength: 1 }),
  app_image: t.String({ minLength: 1 }),
  env: t.Optional(t.Record(t.String(), t.String())),
  health: t.Optional(healthBody),
  seed_image: t.Optional(t.String({ minLength: 1 })),
  seed_env: t.Optional(t.Array(t.String())),
  seed_arg: t.Optional(t.Array(t.String())),
  app_env: t.Optional(t.Array(t.String())),
  services: t.Optional(t.Array(serviceBody)),
  reseed: t.Optional(t.Boolean()),
});

/** Identity is (canonical_repo_id, pr_id); slug is not part of teardown. */
export const teardownBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
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
  health?: HealthRequest;
  seed_image?: string;
  seed_env?: string[];
  seed_arg?: string[];
  app_env?: string[];
  /** Omit = leave companions; `[]` = clear; non-empty = replace. */
  services?: PreviewServiceSpec[];
  reseed?: boolean;
};

/** Cap + `KEY=VALUE` shape check shared by seed_env and app_env. */
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

/** Validate optional seed fields; health is required when seed_image is set. */
export function resolveSeedRequest(
  body: Pick<
    DeployBody,
    "seed_image" | "seed_env" | "seed_arg" | "health" | "reseed"
  >,
):
  | { ok: true; value: SeedImageSpec | undefined }
  | { ok: false; error: string } {
  const seedImage = body.seed_image?.trim();
  const seedEnv = body.seed_env ?? [];
  const seedArg = body.seed_arg ?? [];

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

/** Validate adopter app env (`KEY=VALUE`); empty list is allowed. */
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

/**
 * Validate optional service list.
 * Omitted → undefined (leave companions); present (incl. `[]`) → sync/clear.
 */
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
    out.push(spec);
  }
  return { ok: true, value: out };
}

export type TeardownBody = {
  canonical_repo_id: string;
  pr_id: number;
};

export type PreviewQuery = {
  canonical_repo_id: string;
  pr_id: string;
};

export function deploy(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: DeployBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }): Promise<PreviewSnapshot | { error: string }> => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, body.canonical_repo_id);
    if (!repo.ok) return mapResult(repo, set);
    const identityErr = validatePreviewIdentity(body.slug, body.pr_id);
    if (identityErr) {
      set.status = 422;
      return { error: identityErr };
    }
    if (!validateHostname(body.hostname.trim()).ok) {
      set.status = 422;
      return { error: "invalid_hostname" };
    }
    const connectionEnv = parsePreviewEnvMap(body.env);
    if (!connectionEnv.ok) {
      set.status = 422;
      // Collapse empty → invalid at the HTTP edge (stable API codes).
      const code =
        connectionEnv.issue.code === "empty_env_target"
          ? "invalid_env_target"
          : connectionEnv.issue.code;
      return { error: code };
    }
    const seed = resolveSeedRequest(body);
    if (!seed.ok) {
      set.status = 422;
      return { error: seed.error };
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
      repo: repo.value,
      prId: body.pr_id,
      slug: body.slug,
      hostname: body.hostname,
      appImage: body.app_image,
      health: health.value,
      seed: seed.value,
      appEnv: appEnv.value,
      services: services.value,
      connectionEnv: connectionEnv.value,
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

export function getPreview(deps: LifecycleDeps) {
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
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, body.canonical_repo_id);
    if (!repo.ok) return mapResult(repo, set);
    const prErr = validatePrId(body.pr_id);
    if (prErr) {
      set.status = 422;
      return { error: prErr };
    }

    return mapResult(
      await teardownPreview(deps, {
        repo: repo.value,
        prId: body.pr_id,
      }),
      set,
    );
  };
}
