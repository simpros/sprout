import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import { readPreviewStatus } from "../preview/async-deploy.ts";
import type { LifecycleDeps } from "../preview/lifecycle.ts";
import type { Result } from "../preview/result.ts";
import { validatePrId } from "../preview-db/names.ts";
import { mapResult, resolveRepo } from "./result-map.ts";

/** Default / max Docker `tail` lines for GET …/logs. */
export const DEFAULT_LOG_TAIL = 100;
export const MAX_LOG_TAIL = 10_000;

/** Snapshot-only: no `follow` until SSE streaming ships. */
export const previewLogsQuery = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  tail: t.Optional(t.String()),
});

export const previewLogsParams = t.Object({
  id: t.String({ minLength: 1 }),
});

export type PreviewLogsQuery = {
  canonical_repo_id: string;
  tail?: string;
};

export type PreviewLogsParams = {
  id: string;
};

export type PreviewLogsSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  tail: number;
  app: string;
  seed: string;
};

function parseTail(raw: string | undefined): Result<number> {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, value: DEFAULT_LOG_TAIL };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, status: 422, error: "invalid_tail" };
  }
  return { ok: true, value: Math.min(n, MAX_LOG_TAIL) };
}

/**
 * GET /v1/previews/:id/logs — `:id` is pr_id; repo from query.
 * Reads app + seed container logs (no redaction); seed is often empty after
 * the one-shot seed container is removed.
 */
export function getPreviewLogs(deps: LifecycleDeps) {
  return async ({
    params,
    query,
    auth,
    set,
  }: {
    params: PreviewLogsParams;
    query: PreviewLogsQuery;
    auth: AuthContext | null;
    set: { status?: number | string };
  }): Promise<PreviewLogsSnapshot | { error: string; detail?: string }> => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, query.canonical_repo_id);
    if (!repo.ok) return mapResult(repo, set);

    const prId = Number(params.id);
    const prErr = validatePrId(prId);
    if (prErr) {
      set.status = 422;
      return { error: prErr };
    }

    const tail = parseTail(query.tail);
    if (!tail.ok) return mapResult(tail, set);

    // Same readable-preview gate as GET /v1/preview (404 missing/removed, 409 removing).
    const preview = await readPreviewStatus(deps, repo.value, prId);
    if (!preview.ok) return mapResult(preview, set);

    const logs = await deps.app.logs(preview.value.slug, prId, {
      tail: tail.value,
    });
    return {
      ok: true,
      canonical_repo_id: repo.value,
      pr_id: prId,
      tail: tail.value,
      app: logs.app,
      seed: logs.seed,
    };
  };
}
