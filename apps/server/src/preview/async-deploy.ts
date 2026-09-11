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
  type PreviewRow,
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
      // Same rule as pull-failure persist: only mutate a live intent under the
      // preview lock so teardown cannot be resurrected.
      await withPreviewLock(input.repo, input.prId, async () => {
        const row = await getPreviewRow(deps.db, input.repo, input.prId);
        if (!row || row.status === "removing" || row.status === "removed") {
          return;
        }
        await markPreviewFailed(
          deps.db,
          input.repo,
          input.prId,
          "preview_app_deploy_failed",
        );
      });
    } catch {
      // best-effort
    }
  } finally {
    inFlightDeploys.delete(key);
  }
}

/**
 * missing / removed → 404; removing → 409; else the control-plane row.
 */
export function gateReadablePreviewRow(
  row: PreviewRow | null,
): Result<PreviewRow> {
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

  return { ok: true, value: row };
}

/**
 * Deploy-token-readable preview status for CLI polling after POST /v1/deploy 202.
 * Returns the control-plane snapshot (including sticky last_error fields).
 * Missing/removing stay Result failures; HTTP mapping for those lives at the
 * route via mapResult. Deploy success/failure is decided by the CLI from the
 * snapshot fields — not by inventing a terminal Result over last_error.
 */
export async function readPreviewStatus(
  deps: Pick<LifecycleDeps, "db">,
  repo: string,
  prId: number,
): Promise<Result<PreviewSnapshot>> {
  const gated = gateReadablePreviewRow(
    await getPreviewRow(deps.db, repo, prId),
  );
  if (!gated.ok) return gated;
  return { ok: true, value: previewSnapshotFromRow(gated.value) };
}
