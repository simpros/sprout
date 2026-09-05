import { and, eq, ne } from "drizzle-orm";
import { t } from "elysia";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  teardownPreview,
  type LifecycleDeps,
} from "../preview-db/lifecycle.ts";
import { validatePrId } from "../preview-db/names.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import type { ContainerPorts } from "../preview/containers.ts";
import { planOrphans } from "../sweep/reconcile.ts";

export type ListedPreview = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: string;
  created_at: string;
};

export type DoctorOrphan =
  | {
      kind: "orphan-db";
      slug: string;
      pr_id: number;
      db_name: string;
    }
  | {
      kind: "orphan-container";
      slug: string;
      pr_id: number;
    };

export type DoctorDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  containers: ContainerPorts;
};

export type DropDeps = LifecycleDeps & {
  containers: ContainerPorts;
};

export const dropBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  yes: t.Optional(t.Boolean()),
});

export type DropBody = {
  canonical_repo_id: string;
  pr_id: number;
  yes?: boolean;
};

export function listPreviews(db: StateDb) {
  return async () => {
    const rows = await db
      .select()
      .from(previews)
      .where(ne(previews.status, "removed"));

    const listed: ListedPreview[] = rows.map((row) => ({
      canonical_repo_id: row.canonicalRepoId,
      pr_id: row.prId,
      slug: row.slug,
      db_name: row.dbName,
      hostname: row.hostname,
      status: row.status,
      created_at: row.createdAt,
    }));

    return { previews: listed };
  };
}

export function doctor(deps: DoctorDeps) {
  return async ({ set }: { set: { status?: number | string } }) => {
    const { postgres, docker, orphans } = await collectDoctorFindings(deps);

    if (postgres === "ok" && docker === "ok" && orphans.length === 0) {
      return { ok: true, postgres, docker, orphans };
    }

    set.status = 503;
    return {
      ok: false,
      error: "doctor_failed",
      postgres,
      docker,
      orphans,
    };
  };
}

export function drop(deps: DropDeps) {
  return async ({
    body,
    set,
  }: {
    body: DropBody;
    set: { status?: number | string };
  }) => {
    const prErr = validatePrId(body.pr_id);
    if (prErr) {
      set.status = 422;
      return { error: prErr };
    }

    const [row] = await deps.db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.canonicalRepoId, body.canonical_repo_id),
          eq(previews.prId, body.pr_id),
        ),
      )
      .limit(1);

    if (!row || row.status === "removed") {
      return { ok: true, status: "removed" };
    }

    if (!body.yes) {
      set.status = 409;
      return {
        error: "confirmation_required",
        plan: {
          canonical_repo_id: row.canonicalRepoId,
          pr_id: row.prId,
          slug: row.slug,
          db_name: row.dbName,
          hostname: row.hostname,
          status: row.status,
        },
      };
    }

    const result = await teardownPreview(deps, {
      repo: body.canonical_repo_id,
      prId: body.pr_id,
    });
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    // Best-effort like sweep: DB is already gone; leave orphan-container for doctor.
    try {
      await deps.containers.remove({ slug: row.slug, prId: row.prId });
    } catch {
      /* leave for doctor / next sweep */
    }

    await deps.db
      .delete(previews)
      .where(
        and(
          eq(previews.canonicalRepoId, body.canonical_repo_id),
          eq(previews.prId, body.pr_id),
        ),
      );

    return { ok: true, status: "removed" };
  };
}

async function collectDoctorFindings(deps: DoctorDeps): Promise<{
  postgres: "ok" | "unreachable";
  docker: "ok" | "unreachable";
  orphans: DoctorOrphan[];
}> {
  let postgres: "ok" | "unreachable" = "ok";
  try {
    await deps.previewDb.ping();
  } catch {
    postgres = "unreachable";
  }

  const rows = await deps.db
    .select()
    .from(previews)
    .where(ne(previews.status, "removed"));
  const previewKeys = new Set(rows.map((r) => `${r.slug}:${r.prId}`));

  let catalog: { slug: string; prId: number; dbName: string }[] = [];
  if (postgres === "ok") {
    try {
      catalog = await deps.previewDb.listPreviewDatabases();
    } catch {
      postgres = "unreachable";
    }
  }

  let docker: "ok" | "unreachable" = "ok";
  let containers: { slug: string; prId: number }[] = [];
  try {
    containers = await deps.containers.listPreviewContainers();
  } catch {
    docker = "unreachable";
  }

  const orphans: DoctorOrphan[] = [];
  for (const deletion of planOrphans(previewKeys, catalog, containers)) {
    if (deletion.reason === "sweep:orphan-db") {
      orphans.push({
        kind: "orphan-db",
        slug: deletion.slug,
        pr_id: deletion.prId,
        db_name: deletion.dbName,
      });
    } else if (deletion.reason === "sweep:orphan-container") {
      orphans.push({
        kind: "orphan-container",
        slug: deletion.slug,
        pr_id: deletion.prId,
      });
    }
  }

  return { postgres, docker, orphans };
}
