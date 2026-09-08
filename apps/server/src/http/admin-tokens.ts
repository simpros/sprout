import { t } from "elysia";
import {
  issueDeployToken,
  listTokens as listTokenRows,
  revokeToken as revokeTokenRow,
  type TokenRow,
} from "../auth/store.ts";
import type { StateDb } from "../infrastructure/db/client.ts";

function tokenResponse(row: TokenRow) {
  return {
    id: row.tokenHash,
    scope: row.scope,
    canonical_repo_id: row.canonicalRepoId,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

export const createDeployTokenBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  slug: t.String({ minLength: 1 }),
});

export function listTokens(db: StateDb) {
  return async () => {
    const rows = await listTokenRows(db);
    return { tokens: rows.map(tokenResponse) };
  };
}

export function createDeployToken(db: StateDb) {
  return async ({
    body,
    set,
  }: {
    body: { canonical_repo_id: string; slug: string };
    set: { status?: number | string };
  }) => {
    const result = await issueDeployToken(db, {
      canonicalRepoId: body.canonical_repo_id,
      slug: body.slug,
    });
    if (!result.ok) {
      set.status = 409;
      return { error: "slug conflict" };
    }
    set.status = 201;
    return { ...tokenResponse(result.row), token: result.raw };
  };
}

export function revokeToken(db: StateDb) {
  return async ({
    params,
    set,
  }: {
    params: { id: string };
    set: { status?: number | string };
  }) => {
    const found = await revokeTokenRow(db, params.id);
    if (!found) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  };
}
