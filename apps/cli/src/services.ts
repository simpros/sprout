import type { Result } from "./result.ts";
import type { SproutYamlService } from "./yaml.ts";

const SERVICE_NAME_RE = /^[a-z][a-z0-9]*$/;

export type DeployService = {
  name: string;
  image: string;
  hostname?: string;
  path?: string;
};

/** Parse one `--service name=image` flag. */
export function parseServiceFlag(raw: string): Result<{ name: string; image: string }> {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    return { ok: false, error: `invalid --service: ${raw}` };
  }
  const name = raw.slice(0, eq).trim();
  const image = raw.slice(eq + 1).trim();
  if (!SERVICE_NAME_RE.test(name) || image === "") {
    return { ok: false, error: `invalid --service: ${raw}` };
  }
  return { ok: true, value: { name, image } };
}

/**
 * Merge yaml `preview.services` with repeatable `--service name=image`.
 * CLI images overlay matching names; every service needs an image after merge.
 */
export function mergeServices(
  yamlServices: SproutYamlService[] | undefined,
  flagValues: string[],
): Result<DeployService[] | undefined> {
  const byName = new Map<string, DeployService>();

  for (const svc of yamlServices ?? []) {
    const entry: DeployService = { name: svc.name, image: svc.image ?? "" };
    if (svc.hostname) entry.hostname = svc.hostname;
    if (svc.path) entry.path = svc.path;
    byName.set(svc.name, entry);
  }

  for (const raw of flagValues) {
    const parsed = parseServiceFlag(raw);
    if (!parsed.ok) return parsed;
    const prior = byName.get(parsed.value.name);
    if (prior) {
      prior.image = parsed.value.image;
    } else {
      byName.set(parsed.value.name, {
        name: parsed.value.name,
        image: parsed.value.image,
      });
    }
  }

  if (byName.size === 0) return { ok: true, value: undefined };

  const out: DeployService[] = [];
  for (const svc of byName.values()) {
    if (!svc.image) {
      return {
        ok: false,
        error: `service ${svc.name} requires an image (--service ${svc.name}=<image>)`,
      };
    }
    out.push(svc);
  }
  return { ok: true, value: out };
}
