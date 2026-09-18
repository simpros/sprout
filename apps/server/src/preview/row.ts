import { and, eq } from "drizzle-orm";
import { isDbProvider, type DbProvider } from "@sprout/preview-env";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";

export type PreviewRow = typeof previews.$inferSelect;

/** Stored provider, defaulting missing/empty rows to postgres. */
export function storedProvider(
  row: Pick<PreviewRow, "dbProvider">,
): DbProvider {
  const raw = row.dbProvider as string | null | undefined;
  if (raw == null || raw === "") return "postgres";
  if (isDbProvider(raw)) return raw;
  throw new Error(`unknown db_provider ${JSON.stringify(raw)}`);
}

/** A provider switch is a fresh backend generation, not an identity conflict. */
export function needsBackendRemint(
  row: Pick<PreviewRow, "dbProvider">,
  provider: DbProvider,
): boolean {
  return storedProvider(row) !== provider;
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
