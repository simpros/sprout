/** Host-side Docker helpers for e2e acceptance (inspect only). */

async function dockerText(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout;
}

/**
 * Resolve the running preview app container for (slug, prId).
 * Matches both legacy `pb-` and product `sprout-` name grammars.
 */
export async function previewAppContainerName(
  slug: string,
  prId: number,
): Promise<string> {
  const suffix = `${slug}-pr-${prId}`;
  const stdout = await dockerText([
    "ps",
    "--filter",
    `name=${suffix}`,
    "--format",
    "{{.Names}}",
  ]);
  const app = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((n) => n.endsWith(suffix));
  if (app.length !== 1) {
    throw new Error(
      `expected one preview app container ending in ${suffix}, got: ${JSON.stringify(app)}`,
    );
  }
  return app[0]!;
}

export async function containerEnv(name: string): Promise<string[]> {
  const stdout = await dockerText([
    "inspect",
    "-f",
    "{{json .Config.Env}}",
    name,
  ]);
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((e): e is string => typeof e === "string")
  ) {
    throw new Error(`unexpected Env from docker inspect ${name}: ${stdout}`);
  }
  return parsed;
}

export function envMap(entries: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}
