import { and, eq, ne } from "drizzle-orm";
import { t } from "elysia";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  parsePreviewStatus,
  purgePreview,
  type LifecycleDeps,
  type PreviewStatus,
} from "../preview-db/lifecycle.ts";
import { validatePrId } from "../preview-db/names.ts";
import type { ContainerPorts } from "../preview/containers.ts";
import {
  planOrphanFindings,
  type OrphanFinding,
} from "../sweep/reconcile.ts";

export type ListedPreview = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: PreviewStatus;
  created_at: string;
};

export type DoctorOrphan = OrphanFinding;

export type IntrospectionDeps = LifecycleDeps & {
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
  return async ({ set }: { set: { status?: number | string } }) => {
    const rows = await db
      .select()
      .from(previews)
      .where(ne(previews.status, "removed"));

    const listed: ListedPreview[] = [];
    for (const row of rows) {
      const status = parsePreviewStatus(row.status);
      if (!status.ok) {
        set.status = 500;
        return { error: status.error };
      }
      listed.push({
        canonical_repo_id: row.canonicalRepoId,
        pr_id: row.prId,
        slug: row.slug,
        db_name: row.dbName,
        hostname: row.hostname,
        status: status.value,
        created_at: row.createdAt,
      });
    }

    return { previews: listed };
  };
}

export function doctor(deps: IntrospectionDeps) {
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

export function drop(deps: IntrospectionDeps) {
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
      const status = parsePreviewStatus(row.status);
      if (!status.ok) {
        set.status = 500;
        return { error: status.error };
      }
      set.status = 409;
      return {
        error: "confirmation_required",
        plan: {
          canonical_repo_id: row.canonicalRepoId,
          pr_id: row.prId,
          slug: row.slug,
          db_name: row.dbName,
          hostname: row.hostname,
          status: status.value,
        },
      };
    }

    // Confirmation is intentionally unversioned (repo + prId only); see purgePreview.
    const result = await purgePreview(deps, {
      repo: body.canonical_repo_id,
      prId: body.pr_id,
    });
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    // Best-effort like sweep: control plane is already gone; leave orphan for doctor.
    if (result.value.purged) {
      try {
        await deps.containers.remove({
          slug: result.value.slug,
          prId: result.value.prId,
        });
      } catch {
        /* leave for doctor / next sweep */
      }
    }

    return { ok: true, status: "removed" };
  };
}

async function collectDoctorFindings(deps: IntrospectionDeps): Promise<{
  postgres: "ok" | "unreachable";
  docker: "ok" | "unreachable";
  orphans: DoctorOrphan[];
}> {
  const rows = await deps.db
    .select()
    .from(previews)
    .where(ne(previews.status, "removed"));
  const previewKeys = new Set(rows.map((r) => `${r.slug}:${r.prId}`));

  const [pingResult, catalogResult, containersResult] =
    await Promise.allSettled([
      deps.previewDb.ping(),
      deps.previewDb.listPreviewDatabases(),
      deps.containers.listPreviewContainers(),
    ]);

  const postgres: "ok" | "unreachable" =
    pingResult.status === "fulfilled" && catalogResult.status === "fulfilled"
      ? "ok"
      : "unreachable";

  const catalog =
    postgres === "ok" && catalogResult.status === "fulfilled"
      ? catalogResult.value
      : [];

  const docker: "ok" | "unreachable" =
    containersResult.status === "fulfilled" ? "ok" : "unreachable";
  const containers =
    containersResult.status === "fulfilled" ? containersResult.value : [];

  return {
    postgres,
    docker,
    orphans: planOrphanFindings(previewKeys, catalog, containers),
  };
}
