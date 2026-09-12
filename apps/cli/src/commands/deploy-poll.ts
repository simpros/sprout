import type { ApiClient } from "@sprout/api-client";
import { resolveHealthSpec } from "@sprout/preview-env";
import { readEden } from "../eden.ts";
import type { Result } from "../result.ts";
import type { SproutYaml } from "../yaml.ts";
import {
  deployOutcome,
  type DeploySnapshotFields,
} from "./deploy-outcome.ts";

/** Extra budget beyond health.timeout for image pull + replace + optional seed. */
export const DEPLOY_POLL_BUFFER_MS = 180_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Parse `Ns` durations; missing uses fallback. Malformed throws (no silent default). */
export function parseSecondsMs(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const match = /^(\d+)s$/.exec(raw.trim());
  if (!match) {
    throw new Error(`invalid duration (expected Ns): ${raw}`);
  }
  return Number(match[1]) * 1000;
}

function resolvedHealthOrThrow(yaml: SproutYaml) {
  const health = resolveHealthSpec(yaml.health);
  if (!health.ok) throw new Error(health.issue.code);
  return health.value;
}

export function pollBudgetMs(yaml: SproutYaml): number {
  return resolvedHealthOrThrow(yaml).timeoutMs + DEPLOY_POLL_BUFFER_MS;
}

export function pollIntervalMs(yaml: SproutYaml): number {
  return Math.max(200, resolvedHealthOrThrow(yaml).intervalMs);
}

export type PreviewPoller = {
  client: ApiClient;
  repo: string;
  prId: number;
  budgetMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * Poll GET /v1/preview until the deploy settles. Shared by `sprout deploy`
 * and `sprout ci reseed` — one interpretation of gateway status, one timeout.
 * Gateway error codes surface verbatim so CI fails with the real cause.
 */
export async function pollPreviewReady<T extends DeploySnapshotFields>(
  poller: PreviewPoller,
): Promise<Result<T>> {
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
    const statusResult = readEden<T>(statusResponse);
    if (!statusResult.ok) return { ok: false, error: statusResult.message };
    const outcome = deployOutcome(statusResult.data);
    if (outcome.kind === "failed") return { ok: false, error: outcome.message };
    if (outcome.kind === "ready") return { ok: true, value: statusResult.data };
    await poller.sleep(poller.intervalMs);
  }
}
