import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWorktreeDb,
  type WorktreeDbDeps,
} from "./worktree-db.ts";
import type { CliDeps } from "../context.ts";

function makeDeps(
  dir: string,
  io: { stdout: string[]; stderr: string[] },
): CliDeps {
  return {
    cwd: dir,
    env: {},
    readTextFile: async (path) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return file.text();
    },
    getGitRemoteUrl: () => null,
    createClient: () => {
      throw new Error("gateway client unused for worktree-db");
    },
    io: {
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
    },
  };
}

describe("sprout worktree-db", () => {
  test("provision twice rewrites env file and reuses password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sprout-wt-"));
    const envPath = join(dir, ".env");
    const io = { stdout: [] as string[], stderr: [] as string[] };
    const deps = makeDeps(dir, io);

    const passwords: (string | undefined)[] = [];
    const worktreeDeps: WorktreeDbDeps = {
      provision: async ({ worktreeKey, password }) => {
        expect(worktreeKey).toBe("Agent Alpha!!");
        passwords.push(password);
        const pass = password ?? `pass-${passwords.length}`;
        return {
          worktreeKey: "agent-alpha",
          objectName: "sprout_wt_agent_alpha",
          password: pass,
          host: "127.0.0.1",
          port: 5432,
          databaseUrl:
            `postgres://sprout_wt_agent_alpha:${pass}` +
            `@127.0.0.1:5432/sprout_wt_agent_alpha`,
        };
      },
      drop: async () => {
        throw new Error("drop unused");
      },
      writeTextFile: async (path, contents) => {
        await Bun.write(path, contents);
      },
    };

    const argv = [
      "provision",
      "--slug",
      "Agent Alpha!!",
      "--env-file",
      envPath,
      "--admin-url",
      "postgres://postgres:x@127.0.0.1:5432/postgres",
    ];

    expect(await runWorktreeDb(argv, deps, worktreeDeps)).toBe(0);
    await Bun.write(envPath, `${await Bun.file(envPath).text()}FOO=keep\n`);
    expect(await runWorktreeDb(argv, deps, worktreeDeps)).toBe(0);

    const body = await Bun.file(envPath).text();
    expect(body).toContain("FOO=keep\n");
    expect(body).toContain("PGPASSWORD=pass-1\n");
    expect(body).toContain("PGUSER=sprout_wt_agent_alpha\n");
    expect(body).toContain(
      "DATABASE_URL=postgres://sprout_wt_agent_alpha:pass-1@",
    );
    expect(passwords).toEqual([undefined, "pass-1"]);
    expect(io.stderr).toEqual([]);
  });

  test("drop calls through and prints normalized identity", async () => {
    const io = { stdout: [] as string[], stderr: [] as string[] };
    const deps = makeDeps(process.cwd(), io);
    const dropped: { worktreeKey: string; adminUrl: string }[] = [];
    const worktreeDeps: WorktreeDbDeps = {
      provision: async () => {
        throw new Error("provision unused");
      },
      drop: async (opts) => {
        dropped.push(opts);
        return {
          worktreeKey: "agent-alpha",
          objectName: "sprout_wt_agent_alpha",
        };
      },
      writeTextFile: async () => {
        throw new Error("write unused");
      },
    };

    const code = await runWorktreeDb(
      [
        "drop",
        "--slug",
        "Agent Alpha!!",
        "--admin-url",
        "postgres://postgres:x@127.0.0.1:5432/postgres",
      ],
      deps,
      worktreeDeps,
    );
    expect(code).toBe(0);
    expect(dropped).toEqual([
      {
        worktreeKey: "Agent Alpha!!",
        adminUrl: "postgres://postgres:x@127.0.0.1:5432/postgres",
      },
    ]);
    expect(JSON.parse(io.stdout[0]!)).toEqual({
      ok: true,
      slug: "agent-alpha",
      object_name: "sprout_wt_agent_alpha",
    });
  });

  test("missing flags fail with usage", async () => {
    const io = { stdout: [] as string[], stderr: [] as string[] };
    const deps = makeDeps(process.cwd(), io);
    const code = await runWorktreeDb(["provision"], deps, {
      provision: async () => {
        throw new Error("unused");
      },
      drop: async () => {
        throw new Error("unused");
      },
      writeTextFile: async () => {},
    });
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain("usage: sprout worktree-db provision");
  });
});
