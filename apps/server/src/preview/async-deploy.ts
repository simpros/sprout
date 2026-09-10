import { previewDbName } from "../preview-db/names.ts";
import type { Result } from "./result.ts";
import {
  claimDeployIntent,
  getPreviewRow,
  markPreviewFailed,
  parsePreviewStatus,
  previewSnapshotFromRow,
  provisionPreview,
  withPreviewLock,
  type LifecycleDeps,
  type PreviewSnapshot,
  type ProvisionInput,
} from "./lifecycle.ts";

/**
 * Process-local join table for in-flight background deploys.
 * SQLite is the status source of truth; this map only prevents duplicate
 * background jobs and conflicting identity accepts while a job runs.
 */
const inFlightDeploys = new Map<string, { slug: string; dbName: string }>();

function previewKey(repo: string, prId: number): string {
  return `${repo}\0${prId}`;
}

/**
 * Accept a deploy for async completion: under the preview lock, reject
 * removing / identity conflicts / in-flight identity mismatch, write a
 * provisioning intent row, and return that snapshot. Callers return HTTP 202
 * then invoke {@link runAsyncDeploy} when `launch` is true.
 */
export async function acceptAsyncDeploy(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<{ snapshot: PreviewSnapshot; launch: boolean }>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const requestedDbName = previewDbName(input.slug, input.prId);
    const key = previewKey(input.repo, input.prId);
    const pending = inFlightDeploys.get(key);

    if (pending) {
      if (
        pending.slug === input.slug &&
        pending.dbName === requestedDbName
      ) {
        const row = await getPreviewRow(deps.db, input.repo, input.prId);
        if (row && row.status !== "removed") {
          return {
            ok: true,
            value: {
              snapshot: previewSnapshotFromRow(row),
              launch: false,
            },
          };
        }
      }
      return {
        ok: false,
        status: 409,
        error: "preview_deploy_in_progress",
      };
    }

    const claimed = await claimDeployIntent(deps, input);
    if (!claimed.ok) return claimed;

    inFlightDeploys.set(key, {
      slug: input.slug,
      dbName: requestedDbName,
    });
    return { ok: true, value: { snapshot: claimed.value, launch: true } };
  });
}

/**
 * Background half of async deploy: pull + bring-up.
 * Durable failure is owned by {@link provisionPreview}; this only records
 * unexpected throws so the row cannot sit forever in provisioning.
 */
export async function runAsyncDeploy(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<void> {
  const key = previewKey(input.repo, input.prId);
  try {
    await provisionPreview(deps, input);
  } catch (err) {
    console.warn("provision:background_failed", err);
    try {
      await markPreviewFailed(
        deps.db,
        input.repo,
        input.prId,
        "preview_app_deploy_failed",
      );
    } catch {
      // best-effort
    }
  } finally {
    inFlightDeploys.delete(key);
  }
}

/**
 * Deploy-token-readable preview status for CLI polling after POST /v1/deploy 202.
 * Reads the control-plane row only — no in-memory overlay.
 */
export async function readPreviewStatus(
  deps: Pick<LifecycleDeps, "db">,
  repo: string,
  prId: number,
): Promise<Result<PreviewSnapshot>> {
  const row = await getPreviewRow(deps.db, repo, prId);

  if (!row || row.status === "removed") {
    return { ok: false, status: 404, error: "preview_not_found" };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  if (status.value === "removing") {
    return {
      ok: false,
      status: 409,
      error: "preview_teardown_in_progress",
    };
  }

  if (row.lastError) {
    const error = row.lastError;
    return {
      ok: false,
      status: error === "seed_image_required_to_resume_seeding" ? 422 : 500,
      error,
      ...(row.lastErrorDetail != null
        ? { detail: row.lastErrorDetail }
        : {}),
    };
  }

  if (status.value === "failed") {
    return {
      ok: false,
      status: 500,
      error: "preview_failed",
    };
  }

  return { ok: true, value: previewSnapshotFromRow(row) };
}
