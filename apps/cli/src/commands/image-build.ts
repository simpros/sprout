import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";

/**
 * `docker build -f <dockerfile> -t <ref> .` then `docker push <ref>`.
 * The docker CLI inherits the job env, so dind (`DOCKER_HOST`, TLS) and
 * registry auth work unchanged. Build output streams to the job log;
 * only the exit code is captured.
 */
export async function buildAndPush(
  ctx: CliContext,
  label: string,
  dockerfile: string,
  ref: string,
): Promise<Result<true>> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const build = await run(
    ["docker", "build", "-f", dockerfile, "-t", ref, "."],
    { cwd: ctx.deps.cwd },
  );
  if (build.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image build failed (exit ${build.exitCode})`,
    };
  }
  const push = await run(["docker", "push", ref], { cwd: ctx.deps.cwd });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image push failed (exit ${push.exitCode})`,
    };
  }
  return { ok: true, value: true };
}
