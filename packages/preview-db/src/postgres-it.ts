import { SQL } from "bun";

/** True when a local Docker daemon answers `docker info`. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export type TempPostgres = {
  adminUrl: string;
  hostPort: number;
  stop: () => Promise<void>;
};

/**
 * Ephemeral postgres:16-alpine for admin/role integration tests.
 * Caller must await stop() (e.g. afterAll).
 */
export async function startTempPostgres(
  containerName: string,
): Promise<TempPostgres> {
  const adminPassword = "admin-secret";

  const rm = Bun.spawn(["docker", "rm", "-f", containerName], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await rm.exited;

  const run = Bun.spawn(
    [
      "docker",
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      "POSTGRES_PASSWORD=" + adminPassword,
      "-p",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(run.stdout).text();
  const err = await new Response(run.stderr).text();
  if ((await run.exited) !== 0) {
    throw new Error(`docker run failed: ${err || out}`);
  }

  const portProc = Bun.spawn(
    ["docker", "port", containerName, "5432/tcp"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const portOut = (await new Response(portProc.stdout).text()).trim();
  if ((await portProc.exited) !== 0) {
    throw new Error(`docker port failed: ${portOut}`);
  }
  // e.g. 127.0.0.1:32768
  const hostPort = Number(portOut.split(":").at(-1));
  const adminUrl = `postgres://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${hostPort}/postgres`;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const sql = new SQL(adminUrl);
      await sql`SELECT 1`;
      await sql.close();
      return {
        adminUrl,
        hostPort,
        stop: async () => {
          const stopRm = Bun.spawn(["docker", "rm", "-f", containerName], {
            stdout: "ignore",
            stderr: "ignore",
          });
          await stopRm.exited;
        },
      };
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("postgres container did not become ready");
}
