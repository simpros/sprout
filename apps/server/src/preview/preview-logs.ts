import { and, eq } from "drizzle-orm";
import type { PreviewAppOps, PreviewLogsBundle } from "../app-deployment/ops.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";

/**
 * Load stored seed text + live containers; owns the seed resolution policy
 * so HTTP handlers do not branch on last_error / seed_log.
 */
export async function readPreviewLogs(
  deps: {
    db: StateDb;
    app: Pick<PreviewAppOps, "logs">;
  },
  identity: { canonicalRepoId: string; slug: string; prId: number },
  tail: number,
): Promise<PreviewLogsBundle> {
  const [row] = await deps.db
    .select({ seedLog: previews.seedLog })
    .from(previews)
    .where(
      and(
        eq(previews.canonicalRepoId, identity.canonicalRepoId),
        eq(previews.prId, identity.prId),
      ),
    )
    .limit(1);

  return deps.app.logs({
    slug: identity.slug,
    prId: identity.prId,
    tail,
    storedSeedLog: row?.seedLog ?? null,
  });
}
