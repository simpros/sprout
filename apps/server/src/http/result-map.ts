import type { AuthContext } from "../auth/middleware.ts";
import { gateReadablePreviewRow } from "../preview/async-deploy.ts";
import {
  getPreviewRow,
  previewSnapshotFromRow,
  type LifecycleDeps,
  type PreviewRow,
  type PreviewSnapshot,
} from "../preview/lifecycle.ts";
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
 * Auth → repo scope → pr_id → readable preview row (includes seed_log).
 * Shared by GET /v1/preview (mapped to snapshot) and GET …/logs.
 */
export async function requireReadablePreviewRow(
  deps: Pick<LifecycleDeps, "db">,
  auth: AuthContext | null,
  repoId: string,
  prRaw: string | number,
): Promise<Result<PreviewRow>> {
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
  const row = await getPreviewRow(deps.db, repo.value, prId);
  return gateReadablePreviewRow(row);
}

/** Auth → readable preview as the public status snapshot. */
export async function requireReadablePreview(
  deps: Pick<LifecycleDeps, "db">,
  auth: AuthContext | null,
  repoId: string,
  prRaw: string | number,
): Promise<Result<PreviewSnapshot>> {
  const row = await requireReadablePreviewRow(deps, auth, repoId, prRaw);
  if (!row.ok) return row;
  return { ok: true, value: previewSnapshotFromRow(row.value) };
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
