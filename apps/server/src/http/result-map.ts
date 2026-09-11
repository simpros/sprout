import type { AuthContext } from "../auth/middleware.ts";
import { readPreviewStatus } from "../preview/async-deploy.ts";
import type { LifecycleDeps, PreviewSnapshot } from "../preview/lifecycle.ts";
import type { Result } from "../preview/result.ts";
import { validatePrId } from "../preview-db/names.ts";

/** Deploy-token repo gate shared by lifecycle HTTP handlers. */
export function resolveRepo(
  auth: AuthContext,
  requested: string,
): Result<string> {
  if (auth.scope === "deploy" && auth.canonicalRepoId !== requested) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, value: requested };
}

/**
 * Auth → repo scope → pr_id → readable preview row.
 * Shared by GET /v1/preview and GET /v1/previews/:id/logs.
 */
export async function requireReadablePreview(
  deps: Pick<LifecycleDeps, "db">,
  auth: AuthContext | null,
  repoId: string,
  prRaw: string | number,
): Promise<Result<PreviewSnapshot>> {
  if (!auth) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const repo = resolveRepo(auth, repoId);
  if (!repo.ok) return repo;
  const prId = Number(prRaw);
  const prErr = validatePrId(prId);
  if (prErr) {
    return { ok: false, status: 422, error: prErr };
  }
  return readPreviewStatus(deps, repo.value, prId);
}

/** Map a domain `Result` onto Elysia's `set.status` + error body. */
export function mapResult<T>(
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
