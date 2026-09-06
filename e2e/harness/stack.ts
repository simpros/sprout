import { createApiClient } from "@sprout/api-client";
import { join } from "node:path";
import {
  COMPOSE_E2E_ENV_PATH,
  E2E_COMPOSE_PROJECT,
  e2eConfig,
  repoRoot,
} from "./config.ts";

function composeArgs(extra: string[]): string[] {
  return [
    "compose",
    "-p",
    E2E_COMPOSE_PROJECT,
    "-f",
    join(repoRoot, "docker-compose.yml"),
    "--env-file",
    COMPOSE_E2E_ENV_PATH,
    ...extra,
  ];
}

async function run(
  cmd: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COMPOSE_PROJECT_NAME: E2E_COMPOSE_PROJECT },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !opts.allowFailure) {
    throw new Error(
      `${cmd.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
    );
  }
  return { exitCode, stdout, stderr };
}

export async function composeUp(): Promise<void> {
  await run(["docker", ...composeArgs(["up", "-d", "--build"])]);
}

export async function composeDown(): Promise<void> {
  await run(["docker", ...composeArgs(["down", "-v", "--remove-orphans"])], {
    allowFailure: true,
  });
}

export async function waitForGateway(
  timeoutMs = 120_000,
  intervalMs = 1_000,
): Promise<void> {
  const client = createApiClient(e2eConfig.gatewayUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const res = await client.healthz.get();
      if (res.data?.ok === true) return;
      lastError =
        res.error != null
          ? `eden error ${JSON.stringify(res.error)}`
          : `unexpected body ${JSON.stringify(res.data)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(intervalMs);
  }
  const logs = await run(
    ["docker", ...composeArgs(["logs", "--tail", "200", "gateway"])],
    { allowFailure: true },
  );
  throw new Error(
    `gateway at ${e2eConfig.gatewayUrl} not healthy within ${timeoutMs}ms (${lastError})\n` +
      `--- docker compose logs gateway ---\n${logs.stdout}${logs.stderr}`,
  );
}
