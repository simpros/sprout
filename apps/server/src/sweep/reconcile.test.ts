import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createForgeClient } from "../forge/client.ts";
import { forgeApiError } from "../forge/types.ts";
import {
  runSweepPass,
  type CatalogDbRef,
  type PreviewRef,
  type SweepDeletion,
  type SweepPorts,
  type SweepPreview,
} from "./reconcile.ts";

function memoryPorts(seed: {
  previews?: SweepPreview[];
  catalog?: CatalogDbRef[] | Error;
  containers?: PreviewRef[] | Error;
  openPrs?: Record<string, number[] | Error>;
  dropErrorFor?: (deletion: SweepDeletion) => Error | undefined;
  log?: SweepPorts["log"];
}): {
  ports: SweepPorts;
  deletions: SweepDeletion[];
  forgeCalls: string[];
  logs: string[];
} {
  const deletions: SweepDeletion[] = [];
  const forgeCalls: string[] = [];
  const logs: string[] = [];
  const previews = seed.previews ?? [];
  const catalog = seed.catalog ?? [];
  const containers = seed.containers ?? [];
  const openPrs = seed.openPrs ?? {};

  const ports: SweepPorts = {
    listPreviews: async () => [...previews],
    listCatalogDatabases: async () => {
      if (catalog instanceof Error) throw catalog;
      return [...catalog];
    },
    listPreviewContainers: async () => {
      if (containers instanceof Error) throw containers;
      return [...containers];
    },
    listOpenPrIds: async (canonicalRepoId) => {
      forgeCalls.push(canonicalRepoId);
      const entry = openPrs[canonicalRepoId];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
    drop: async (deletion) => {
      const err = seed.dropErrorFor?.(deletion);
      if (err) throw err;
      deletions.push(deletion);
      return true;
    },
    ttlHours: 72,
    log: (message, deletion) => {
      logs.push(message);
      seed.log?.(message, deletion);
    },
  };

  return { ports, deletions, forgeCalls, logs };
}

describe("runSweepPass", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("drops preview whose PR is not open with sweep:pr-not-open", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      openPrs: { "https://github.com/acme/widgets": [99] },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(deletions).toEqual([
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "sprout_widgets_pr10",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });

  test("drops TTL-expired preview with sweep:ttl-expired", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, forgeCalls } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 5,
          slug: "widgets",
          dbName: "sprout_widgets_pr5",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
      ],
      openPrs: { "https://github.com/acme/widgets": [5] },
    });

    await runSweepPass(ports);
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 5,
        slug: "widgets",
        dbName: "sprout_widgets_pr5",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
    ]);
    // TTL-only candidates never need a forge round-trip.
    expect(forgeCalls).toEqual([]);
  });

  test("drops orphan catalog DB with sweep:orphan-db", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, logs } = memoryPorts({
      previews: [],
      catalog: [{ dbName: "sprout_widgets_pr42", slug: "widgets", prId: 42 }],
      openPrs: { "https://github.com/acme/widgets": [] },
    });

    await runSweepPass(ports);
    expect(deletions).toEqual([
      {
        reason: "sweep:orphan-db",
        prId: 42,
        slug: "widgets",
        dbName: "sprout_widgets_pr42",
      },
    ]);
    expect(logs).toContain("deleted (sweep:orphan-db)");
  });

  test("drops orphan container with sweep:orphan-container", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, logs } = memoryPorts({
      previews: [],
      containers: [{ slug: "widgets", prId: 55 }],
    });

    await runSweepPass(ports);
    expect(deletions).toEqual([
      {
        reason: "sweep:orphan-container",
        prId: 55,
        slug: "widgets",
      },
    ]);
    expect(logs).toContain("deleted (sweep:orphan-container)");
  });

  test("emits separate orphan-db and orphan-container for the same slug:prId", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, logs } = memoryPorts({
      previews: [],
      catalog: [{ dbName: "sprout_widgets_pr42", slug: "widgets", prId: 42 }],
      containers: [{ slug: "widgets", prId: 42 }],
    });

    await runSweepPass(ports);
    expect(deletions).toEqual([
      {
        reason: "sweep:orphan-db",
        prId: 42,
        slug: "widgets",
        dbName: "sprout_widgets_pr42",
      },
      {
        reason: "sweep:orphan-container",
        prId: 42,
        slug: "widgets",
      },
    ]);
    expect(logs).toContain("deleted (sweep:orphan-db)");
    expect(logs).toContain("deleted (sweep:orphan-container)");
  });

  test("empty forge token soft-fails into forgeRepoFailures; TTL/orphan still run", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const forge = createForgeClient({ forge: "github", token: "" });
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 11,
          slug: "widgets",
          dbName: "sprout_widgets_pr11",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      catalog: [{ dbName: "sprout_widgets_pr99", slug: "widgets", prId: 99 }],
    });
    ports.listOpenPrIds = (repo) => forge.listOpenPrIds(repo);

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([
      "https://github.com/acme/widgets",
    ]);
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "sprout_widgets_pr10",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
      {
        reason: "sweep:orphan-db",
        prId: 99,
        slug: "widgets",
        dbName: "sprout_widgets_pr99",
      },
    ]);
    expect(deletions.some((d) => d.reason === "sweep:pr-not-open")).toBe(false);
  });

  test("forge API failure still drops TTL and orphans; skips pr-not-open only", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 11,
          slug: "widgets",
          dbName: "sprout_widgets_pr11",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      catalog: [{ dbName: "sprout_widgets_pr99", slug: "widgets", prId: 99 }],
      openPrs: {
        "https://github.com/acme/widgets": forgeApiError("forge down", 502),
      },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([
      "https://github.com/acme/widgets",
    ]);
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "sprout_widgets_pr10",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
      {
        reason: "sweep:orphan-db",
        prId: 99,
        slug: "widgets",
        dbName: "sprout_widgets_pr99",
      },
    ]);
  });

  test("forge failure for one repo still deletes closed PRs in other repos", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/repo-a",
          prId: 1,
          slug: "repoa",
          dbName: "sprout_repoa_pr1",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/repo-b",
          prId: 2,
          slug: "repob",
          dbName: "sprout_repob_pr2",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      openPrs: {
        "https://github.com/acme/repo-a": forgeApiError("forge down", 502),
        "https://github.com/acme/repo-b": [],
      },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([
      "https://github.com/acme/repo-a",
    ]);
    expect(deletions).toEqual([
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://github.com/acme/repo-b",
        prId: 2,
        slug: "repob",
        dbName: "sprout_repob_pr2",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });

  test("one pass reconciles a GitHub repo and a GitLab repo via routing forge client", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const forge = createForgeClient({
      githubToken: "gh",
      gitlabToken: "gl",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          // PR 10 open; 11 closed
          return new Response(JSON.stringify([{ number: 10 }]), { status: 200 });
        }
        if (url.includes("gitlab.com/api/v4")) {
          // MR 20 open; 21 closed
          return new Response(JSON.stringify([{ iid: 20 }]), { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://gitlab.com/acme/sprouts",
          prId: 20,
          slug: "sprouts",
          dbName: "sprout_sprouts_pr20",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 11,
          slug: "widgets",
          dbName: "sprout_widgets_pr11",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://gitlab.com/acme/sprouts",
          prId: 21,
          slug: "sprouts",
          dbName: "sprout_sprouts_pr21",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
    });
    ports.listOpenPrIds = (repo) => forge.listOpenPrIds(repo);

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(deletions).toEqual([
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 11,
        slug: "widgets",
        dbName: "sprout_widgets_pr11",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://gitlab.com/acme/sprouts",
        prId: 21,
        slug: "sprouts",
        dbName: "sprout_sprouts_pr21",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });

  test("invalid canonical repo id soft-fails into forgeRepoFailures", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 3,
          slug: "widgets",
          dbName: "sprout_widgets_pr3",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      openPrs: {
        "https://github.com/acme/widgets": forgeApiError(
          "Invalid GitHub canonical repo id: https://github.com/acme/widgets",
          400,
        ),
      },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([
      "https://github.com/acme/widgets",
    ]);
    expect(deletions).toEqual([]);
  });

  test("rethrows non-forge errors instead of skipping", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 3,
          slug: "widgets",
          dbName: "sprout_widgets_pr3",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      openPrs: {
        "https://github.com/acme/widgets": new Error("programmer invariant boom"),
      },
    });

    await expect(runSweepPass(ports)).rejects.toThrow(
      "programmer invariant boom",
    );
  });

  test("container catalog failure soft-fails; TTL and pr-not-open still run", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, logs } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 11,
          slug: "widgets",
          dbName: "sprout_widgets_pr11",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      catalog: [{ dbName: "sprout_widgets_pr99", slug: "widgets", prId: 99 }],
      containers: new Error("Docker list containers failed"),
      openPrs: { "https://github.com/acme/widgets": [] },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(logs.some((m) => m.includes("sweep preview containers failed"))).toBe(
      true,
    );
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "sprout_widgets_pr10",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
      {
        reason: "sweep:orphan-db",
        prId: 99,
        slug: "widgets",
        dbName: "sprout_widgets_pr99",
      },
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 11,
        slug: "widgets",
        dbName: "sprout_widgets_pr11",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });

  test("postgres catalog failure soft-fails; TTL still runs", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions, logs } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 10,
          slug: "widgets",
          dbName: "sprout_widgets_pr10",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
      ],
      catalog: new Error("postgres catalog boom"),
      containers: [{ slug: "widgets", prId: 55 }],
    });

    await runSweepPass(ports);
    expect(logs.some((m) => m.includes("sweep catalog databases failed"))).toBe(
      true,
    );
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "sprout_widgets_pr10",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
      {
        reason: "sweep:orphan-container",
        prId: 55,
        slug: "widgets",
      },
    ]);
  });

  test("preview list failure hard-fails the pass", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports } = memoryPorts({});
    ports.listPreviews = async () => {
      throw new Error("sqlite unavailable");
    };

    await expect(runSweepPass(ports)).rejects.toThrow("sqlite unavailable");
  });

  test("keeps open non-expired preview", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 3,
          slug: "widgets",
          dbName: "sprout_widgets_pr3",
          createdAt: "2026-09-02T12:00:00.000Z",
          createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
          status: "running",
        },
      ],
      catalog: [{ dbName: "sprout_widgets_pr3", slug: "widgets", prId: 3 }],
      containers: [{ slug: "widgets", prId: 3 }],
      openPrs: { "https://github.com/acme/widgets": [3] },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(deletions).toEqual([]);
  });

  test("continues other drops when one drop fails", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { ports, deletions } = memoryPorts({
      previews: [
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 1,
          slug: "widgets",
          dbName: "sprout_widgets_pr1",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/acme/widgets",
          prId: 2,
          slug: "widgets",
          dbName: "sprout_widgets_pr2",
          createdAt: "2026-08-01T12:00:00.000Z",
          createdAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
          status: "running",
        },
      ],
      dropErrorFor: (deletion) =>
        deletion.prId === 1 ? new Error("drop boom") : undefined,
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(deletions).toEqual([
      {
        reason: "sweep:ttl-expired",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 2,
        slug: "widgets",
        dbName: "sprout_widgets_pr2",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
    ]);
  });
});
