import type { PreviewAppOps } from "../app-deployment/replace.ts";
import type { ForgeClient } from "../forge/client.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  dropOrphanDatabase,
  purgePreview,
  removePreview,
  type LifecycleDeps,
  type TeardownDeps,
} from "../preview/lifecycle.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import type {
  SweepDeletion,
  SweepPorts,
  SweepPreview,
} from "./reconcile.ts";

export type PreviewResourceDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  app: PreviewAppOps;
  forge: ForgeClient;
  ttlHours: number;
  log?: SweepPorts["log"];
};

function teardownDeps(deps: PreviewResourceDeps): TeardownDeps {
  return {
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
  };
}

function lifecycleDeps(deps: PreviewResourceDeps): LifecycleDeps {
  return {
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
  };
}

export type LiveSweepDeps = PreviewResourceDeps & {
  forge: ForgeClient;
  ttlHours: number;
};

/**
 * Shared destroy path: lifecycle remove (tombstone or purge) under lock,
 * then best-effort container remove after unlock (same as sweep).
 */
export async function destroyPreviewResources(
  deps: PreviewResourceDeps,
  target:
    | {
        disposition: "tombstone";
        repo: string;
        prId: number;
        slug: string;
        expectedDbName: string;
        expectedCreatedAt: string;
        /** Optional sweep deletion for log context. */
        deletion?: SweepDeletion;
      }
    | {
        disposition: "purge";
        repo: string;
        prId: number;
      },
): Promise<
  { ok: true; removed: boolean } | { ok: false; status: number; error: string }
> {
  if (target.disposition === "tombstone") {
    const result = await removePreview(teardownDeps(deps), {
      repo: target.repo,
      prId: target.prId,
      expectedDbName: target.expectedDbName,
      expectedCreatedAt: target.expectedCreatedAt,
    });
    if (!result.ok) return result;
    if (!result.value) return { ok: true, removed: false };
  } else {
    const result = await purgePreview(lifecycleDeps(deps), {
      repo: target.repo,
      prId: target.prId,
    });
    if (!result.ok) return result;
    if (!result.value.purged) return { ok: true, removed: false };
  }

  return { ok: true, removed: true };
}

async function removeControlPlane(
  deps: LiveSweepDeps,
  deletion: Extract<
    SweepDeletion,
    { reason: "sweep:ttl-expired" | "sweep:pr-not-open" }
  >,
): Promise<boolean> {
  const result = await destroyPreviewResources(deps, {
    disposition: "tombstone",
    repo: deletion.canonicalRepoId,
    prId: deletion.prId,
    slug: deletion.slug,
    expectedDbName: deletion.dbName,
    expectedCreatedAt: deletion.createdAt,
    deletion,
  });
  if (!result.ok) {
    deps.log?.(`sweep drop database failed: ${result.error}`, deletion);
    throw new Error(`teardown incomplete: ${deletion.dbName}`);
  }
  return result.removed;
}

export function createLiveSweepPorts(deps: LiveSweepDeps): SweepPorts {
  return {
    ttlHours: deps.ttlHours,
    log: deps.log,
    listPreviews: async () => {
      const rows = await deps.db.select().from(previews);
      const out: SweepPreview[] = [];
      for (const row of rows) {
        const createdAtMs = parseUnambiguousUtcMs(row.createdAt);
        if (createdAtMs === null) {
          deps.log?.(
            `sweep preview invalid createdAt ${row.createdAt} (${row.slug}:${row.prId})`,
          );
        }
        out.push({
          canonicalRepoId: row.canonicalRepoId,
          prId: row.prId,
          slug: row.slug,
          dbName: row.dbName,
          createdAt: row.createdAt,
          createdAtMs,
          status: row.status,
        });
      }
      return out;
    },
    listCatalogDatabases: async () =>
      (await deps.previewDb.listPreviewDatabases()).map(
        ({ slug, prId, dbName }) => ({ slug, prId, dbName }),
      ),
    listPreviewContainers: async () =>
      (await deps.app.list()).map(({ slug, prId }) => ({
        slug,
        prId,
      })),
    listOpenPrIds: (canonicalRepoId) =>
      deps.forge.listOpenPrIds(canonicalRepoId),
    drop: async (deletion: SweepDeletion) => {
      switch (deletion.reason) {
        case "sweep:ttl-expired":
          return removeControlPlane(deps, deletion);
        case "sweep:pr-not-open": {
          // Forge outside the preview lock — under lock only checks generation.
          const open = await deps.forge.listOpenPrIds(
            deletion.canonicalRepoId,
          );
          if (open.includes(deletion.prId)) return false;
          return removeControlPlane(deps, deletion);
        }
        case "sweep:orphan-db": {
          try {
            return await dropOrphanDatabase(
              teardownDeps(deps),
              deletion.dbName,
            );
          } catch (error) {
            deps.log?.(
              `sweep drop database failed: ${String(error)}`,
              deletion,
            );
            throw new Error(`teardown incomplete: ${deletion.dbName}`);
          }
        }
        case "sweep:orphan-container": {
          try {
            await deps.app.remove(deletion.slug, deletion.prId);
            return true;
          } catch (error) {
            deps.log?.(
              `sweep remove container failed: ${String(error)}`,
              deletion,
            );
            throw new Error(
              `teardown incomplete: ${deletion.slug}:${deletion.prId}`,
            );
          }
        }
      }
    },
  };
}