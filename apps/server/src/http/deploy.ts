import { parsePreviewEnvMap } from "@sprout/preview-env";
import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import {
  resolveHealthSpec,
  type HealthRequest,
} from "../app-deployment/health.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import {
  provisionPreview,
  teardownPreview,
  type LifecycleDeps,
} from "../preview/lifecycle.ts";
import { validatePrId, validateSlug } from "../preview-db/names.ts";

export type { LifecycleDeps };

export const healthBody = t.Object({
  path: t.String({ minLength: 1 }),
  interval: t.String({ minLength: 1 }),
  timeout: t.String({ minLength: 1 }),
  expect: t.Number(),
});

export const MAX_SEED_ENV = 16;
export const MAX_SEED_ARG = 16;
export const MAX_APP_ENV = 32;

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
});

/** Identity is (canonical_repo_id, pr_id); slug is not part of teardown. */
export const teardownBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
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
  body: Pick<DeployBody, "seed_image" | "seed_env" | "seed_arg" | "health">,
):
  | { ok: true; value: SeedImageSpec | undefined }
  | { ok: false; error: string } {
  const seedImage = body.seed_image?.trim();
  const seedEnv = body.seed_env ?? [];
  const seedArg = body.seed_arg ?? [];

  if (!seedImage) {
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

/** Validate optional adopter app env (`KEY=VALUE`); empty → undefined. */
export function resolveAppEnvRequest(
  body: Pick<DeployBody, "app_env">,
):
  | { ok: true; value: string[] | undefined }
  | { ok: false; error: string } {
  const appEnv = body.app_env ?? [];
  if (appEnv.length === 0) {
    return { ok: true, value: undefined };
  }
  const check = validateKvEnvEntries(appEnv, {
    max: MAX_APP_ENV,
    tooMany: "too_many_app_env",
    invalid: "invalid_app_env",
  });
  if (!check.ok) return check;
  return { ok: true, value: appEnv };
}

export type TeardownBody = {
  canonical_repo_id: string;
  pr_id: number;
};

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; detail?: string };

function resolveRepo(
  auth: AuthContext,
  requested: string,
): Result<string> {
  if (auth.scope === "deploy" && auth.canonicalRepoId !== requested) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, value: requested };
}

function mapResult<T>(
  result: Result<T>,
  set: { status?: number | string },
): T | { error: string; detail?: string } {
  if (!result.ok) {
    set.status = result.status;
    return result.detail !== undefined
      ? { error: result.error, detail: result.detail }
      : { error: result.error };
  }
  return result.value;
}

export function deploy(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: DeployBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, body.canonical_repo_id);
    if (!repo.ok) return mapResult(repo, set);
    const slugErr = validateSlug(body.slug);
    if (slugErr) {
      set.status = 422;
      return { error: slugErr };
    }
    const prErr = validatePrId(body.pr_id);
    if (prErr) {
      set.status = 422;
      return { error: prErr };
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
    const health = resolveHealthSpec(body.health);
    if (!health.ok) {
      set.status = 422;
      return { error: health.error };
    }

    return mapResult(
      await provisionPreview(deps, {
        repo: repo.value,
        prId: body.pr_id,
        slug: body.slug,
        hostname: body.hostname,
        appImage: body.app_image,
        health: health.value,
        seed: seed.value,
        appEnv: appEnv.value,
        connectionEnv: connectionEnv.value,
      }),
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
