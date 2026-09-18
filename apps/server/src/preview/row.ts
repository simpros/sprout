import { and, eq } from "drizzle-orm";
import type { DbProvider } from "@sprout/preview-env";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";

export type PreviewRow = typeof previews.$inferSelect;

/** Stored provider, defaulting pre-column rows to postgres. */
export function storedProvider(
  row: Pick<PreviewRow, "dbProvider">,
): DbProvider {
  return row.dbProvider === "sqlite" ? "sqlite" : "postgres";
}

export function utcIsoNow(): string {
  return new Date().toISOString();
}

export async function updatePreviewRow(
  db: StateDb,
  row: Pick<PreviewRow, "canonicalRepoId" | "prId">,
  values: Partial<typeof previews.$inferInsert>,
  missingError: string,
): Promise<PreviewRow> {
  const [updated] = await db
    .update(previews)
    .set(values)
    .where(
      and(
        eq(previews.canonicalRepoId, row.canonicalRepoId),
        eq(previews.prId, row.prId),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error(missingError);
  }
  return updated;
}
