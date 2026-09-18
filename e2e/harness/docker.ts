import { run } from "./exec.ts";

export function previewAppContainerName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}`;
}

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

export function sqliteVolumeName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-sqlite`;
}

export type ContainerMount = {
  Name?: string;
  Source?: string;
  Destination?: string;
};

export async function containerMounts(name: string): Promise<ContainerMount[]> {
  const stdout = await dockerText([
    "inspect",
    "-f",
    "{{json .Mounts}}",
    name,
  ]);
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected Mounts from docker inspect ${name}: ${stdout}`);
  }
  return parsed as ContainerMount[];
}

export async function execInContainer(
  name: string,
  args: string[],
): Promise<string> {
  const { stdout } = await run(["docker", "exec", name, ...args]);
  return stdout;
}

export async function volumeExists(name: string): Promise<boolean> {
  const { exitCode } = await run(["docker", "volume", "inspect", name], {
    allowFailure: true,
  });
  return exitCode === 0;
}
