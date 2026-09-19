import type { ApiClient } from "@sprout/api-client";
import { readEden } from "../eden.ts";
import type { Result } from "../result.ts";
import {
  deployOutcome,
  toDeploySettled,
  type DeploySettled,
  type DeploySnapshotFields,
} from "./deploy-outcome.ts";

/** Extra budget beyond health.timeout for image pull + replace + optional seed. */
export const DEPLOY_POLL_BUFFER_MS = 180_000;

export type PreviewPoller = {
  client: ApiClient;
  repo: string;
  prId: number;
  budgetMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export async function pollPreviewReady(
  poller: PreviewPoller,
): Promise<Result<DeploySettled>> {
  const deadline = poller.now() + poller.budgetMs;
  while (true) {
    if (poller.now() >= deadline) {
      return { ok: false, error: "deploy_timeout" };
    }
    const statusResponse = await poller.client.v1.preview.get({
      query: {
        canonical_repo_id: poller.repo,
        pr_id: String(poller.prId),
      },
    });
    const statusResult = readEden<DeploySnapshotFields>(statusResponse);
    if (!statusResult.ok) return { ok: false, error: statusResult.message };
    const outcome = deployOutcome(statusResult.data);
    if (outcome.kind === "failed") return { ok: false, error: outcome.message };
    if (outcome.kind === "ready") {
      return { ok: true, value: toDeploySettled(outcome) };
    }
    await poller.sleep(poller.intervalMs);
  }
}
