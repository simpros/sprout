import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { dockerAvailable, startTempPostgres } from "./postgres-it.ts";
import {
  assertWorktreeObjectName,
  dropWorktreeDb,
  provisionWorktreeDb,
} from "./index.ts";

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("worktree-db provision/drop (postgres)", () => {
  let adminUrl = "";
  let hostPort = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pg = await startTempPostgres(`sprout-preview-db-wt-${process.pid}`);
    adminUrl = pg.adminUrl;
    hostPort = pg.hostPort;
    stop = pg.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  test("provision twice is idempotent and authenticates", async () => {
    const worktreeKey = "agent-alpha";
    const first = await provisionWorktreeDb({
      adminUrl,
      worktreeKey,
      password: "first-pass",
    });
    expect(first.objectName).toBe("sprout_wt_agent_alpha");
    expect(first.worktreeKey).toBe("agent-alpha");
    expect(first.port).toBe(hostPort);

    const login1 = new SQL(first.databaseUrl);
    await login1`SELECT 1`;
    await login1.close();

    const second = await provisionWorktreeDb({
      adminUrl,
      worktreeKey,
      password: "first-pass",
    });
    expect(second.objectName).toBe(first.objectName);

    const login2 = new SQL(second.databaseUrl);
    await login2`SELECT 1`;
    await login2.close();
  });

  test("drop removes db + role and returns normalized identity", async () => {
    const worktreeKey = "To Drop!!";
    await provisionWorktreeDb({
      adminUrl,
      worktreeKey,
      password: "drop-pass",
    });

    const dropped = await dropWorktreeDb({ adminUrl, worktreeKey });
    expect(dropped).toEqual({
      worktreeKey: "to-drop",
      objectName: "sprout_wt_to_drop",
    });

    const admin = new SQL(adminUrl);
    const dbs = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = 'sprout_wt_to_drop'
    `;
    const roles = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'sprout_wt_to_drop'
    `;
    expect(dbs[0]?.n).toBe(0);
    expect(roles[0]?.n).toBe(0);
    await admin.close();

    expect(() => assertWorktreeObjectName("postgres")).toThrow(/non-worktree/);
    expect(() => assertWorktreeObjectName("sprout_widgets_pr1")).toThrow(
      /non-worktree/,
    );
  });
});
