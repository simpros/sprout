import type {
  LiveContainerLogs,
  PreviewAppOps,
} from "../app-deployment/ops.ts";

export type PreviewLogsBundle = {
  app: string;
  seed: string;
};

export function mergeSeedText(
  liveSeed: string | null,
  storedSeedLog: string | null,
): string {
  return liveSeed !== null ? liveSeed : (storedSeedLog ?? "");
}

export function mergePreviewLogs(
  live: LiveContainerLogs,
  storedSeedLog: string | null,
): PreviewLogsBundle {
  return {
    app: live.app ?? "",
    seed: mergeSeedText(live.seed, storedSeedLog),
  };
}

export async function readPreviewLogs(
  deps: { app: Pick<PreviewAppOps, "liveLogs"> },
  input: {
    slug: string;
    prId: number;
    tail: number;
    storedSeedLog: string | null;
  },
): Promise<PreviewLogsBundle> {
  const live = await deps.app.liveLogs({
    slug: input.slug,
    prId: input.prId,
    tail: input.tail,
  });
  return mergePreviewLogs(live, input.storedSeedLog);
}
