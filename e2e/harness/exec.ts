import { repoRoot, E2E_COMPOSE_PROJECT } from "./config.ts";

export async function run(
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
