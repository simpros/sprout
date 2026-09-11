import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import type { LifecycleDeps } from "../preview/lifecycle.ts";
import { readPreviewLogs } from "../preview/preview-logs.ts";
import type { Result } from "../preview/result.ts";
import { mapResult, requireReadablePreview } from "./result-map.ts";

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
 * Live app logs + seed text (live-if-present, else stored seed_log).
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
    const preview = await requireReadablePreview(
      deps,
      auth,
      query.canonical_repo_id,
      params.id,
    );
    if (!preview.ok) return mapResult(preview, set);

    const tail = parseTail(query.tail);
    if (!tail.ok) return mapResult(tail, set);

    const { app, seed } = await readPreviewLogs(
      deps,
      {
        canonicalRepoId: preview.value.canonical_repo_id,
        slug: preview.value.slug,
        prId: preview.value.pr_id,
      },
      tail.value,
    );
    return {
      ok: true,
      canonical_repo_id: preview.value.canonical_repo_id,
      pr_id: preview.value.pr_id,
      tail: tail.value,
      app,
      seed,
    };
  };
}
