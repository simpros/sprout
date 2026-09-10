import { and, eq, isNull } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { apiTokens, repos } from "../infrastructure/db/schema.ts";
import { generateToken, hashToken } from "./tokens.ts";

export type AuthContext =
  | { tokenHash: string; scope: "admin"; canonicalRepoId: null }
  | { tokenHash: string; scope: "deploy"; canonicalRepoId: string };

export type TokenRow = {
  tokenHash: string;
  scope: string;
  canonicalRepoId: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type IssueDeployTokenResult =
  | { ok: true; raw: string; row: TokenRow }
  | { ok: false; error: "slug_conflict" };

function asAuth(row: {
  tokenHash: string;
  scope: string;
  canonicalRepoId: string | null;
}): AuthContext | null {
  if (row.scope === "admin") {
    return {
      tokenHash: row.tokenHash,
      scope: "admin",
      canonicalRepoId: null,
    };
  }
  if (row.scope === "deploy" && row.canonicalRepoId) {
    return {
      tokenHash: row.tokenHash,
      scope: "deploy",
      canonicalRepoId: row.canonicalRepoId,
    };
  }
  return null;
}

export async function findActive(
  db: StateDb,
  raw: string,
): Promise<AuthContext | null> {
  const [row] = await db
    .select({
      tokenHash: apiTokens.tokenHash,
      scope: apiTokens.scope,
      canonicalRepoId: apiTokens.canonicalRepoId,
    })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(raw)),
        isNull(apiTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return asAuth(row);
}

export async function listTokens(db: StateDb): Promise<TokenRow[]> {
  return db.select().from(apiTokens);
}

export async function revokeToken(
  db: StateDb,
  tokenHash: string,
): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiTokens.tokenHash, tokenHash))
    .returning({ tokenHash: apiTokens.tokenHash });
  return result.length > 0;
}

async function hasActiveAdmin(db: StateDb): Promise<boolean> {
  const rows = await db
    .select({ tokenHash: apiTokens.tokenHash })
    .from(apiTokens)
    .where(and(eq(apiTokens.scope, "admin"), isNull(apiTokens.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

async function upsertActiveAdmin(db: StateDb, tokenHash: string): Promise<void> {
  await db
    .insert(apiTokens)
    .values({ tokenHash, scope: "admin" })
    .onConflictDoUpdate({
      target: apiTokens.tokenHash,
      set: { revokedAt: null, scope: "admin" },
    });
}

export type EnsureAdminTokenResult =
  | { status: "pinned"; raw: string }
  | { status: "generated"; raw: string }
  | { status: "existing" };

/**
 * Ensures an active admin token hash exists.
 * Returns the raw bearer when known (pinned or freshly generated); `existing`
 * means only the hash is in SQLite (CLI must use the persisted file).
 */
export async function ensureAdminToken(
  db: StateDb,
  configured?: string,
): Promise<EnsureAdminTokenResult> {
  if (configured) {
    await upsertActiveAdmin(db, hashToken(configured));
    return { status: "pinned", raw: configured };
  }
  if (await hasActiveAdmin(db)) return { status: "existing" };
  const raw = generateToken();
  await db.insert(apiTokens).values({
    tokenHash: hashToken(raw),
    scope: "admin",
  });
  return { status: "generated", raw };
}

export async function issueDeployToken(
  db: StateDb,
  input: { canonicalRepoId: string; slug: string },
): Promise<IssueDeployTokenResult> {
  const raw = generateToken();
  const tokenHash = hashToken(raw);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ slug: repos.slug })
      .from(repos)
      .where(eq(repos.canonicalId, input.canonicalRepoId))
      .limit(1);

    if (existing) {
      if (existing.slug !== input.slug) {
        return { ok: false as const, error: "slug_conflict" as const };
      }
    } else {
      await tx.insert(repos).values({
        canonicalId: input.canonicalRepoId,
        slug: input.slug,
      });
    }

    const [row] = await tx
      .insert(apiTokens)
      .values({
        tokenHash,
        scope: "deploy",
        canonicalRepoId: input.canonicalRepoId,
      })
      .returning();

    return { ok: true as const, raw, row };
  });
}
