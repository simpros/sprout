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

const inFlightDeploys = new Map<string, { slug: string; dbName: string | null }>();

function previewKey(repo: string, prId: number): string {
  return `${repo}\0${prId}`;
}

export async function acceptAsyncDeploy(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<{ snapshot: PreviewSnapshot; launch: boolean }>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const requestedDbName =
      input.plan.provider === "none"
        ? null
        : previewDbName(input.slug, input.prId);
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
    }
  } finally {
    inFlightDeploys.delete(key);
  }
}

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
