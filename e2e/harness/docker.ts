/** Host-side Docker helpers for e2e acceptance (inspect only). */
import { run } from "./exec.ts";

async function dockerText(args: string[]): Promise<string> {
  const { stdout } = await run(["docker", ...args]);
  return stdout;
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
    if (eq <= 0) {
      throw new Error(
        `malformed container env entry (expected KEY=VALUE): ${JSON.stringify(entry)}`,
      );
    }
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}
