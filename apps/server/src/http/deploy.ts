import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import {
  resolveHealthSpec,
  type HealthRequest,
} from "../app-deployment/health.ts";
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

export const deployBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
  hostname: t.String({ minLength: 1 }),
  app_image: t.String({ minLength: 1 }),
  health: t.Optional(healthBody),
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
  health?: HealthRequest;
};

export type TeardownBody = {
  canonical_repo_id: string;
  pr_id: number;
};

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

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
): T | { error: string } {
  if (!result.ok) {
    set.status = result.status;
    return { error: result.error };
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
