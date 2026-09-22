import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(deployDir, "..");

type ComposeDoc = {
  services?: Record<string, Record<string, unknown>>;
};

async function loadYaml(path: string): Promise<ComposeDoc> {
  const text = await Bun.file(path).text();
  return Bun.YAML.parse(text) as ComposeDoc;
}

function service(doc: ComposeDoc, name: string): Record<string, unknown> {
  const svc = doc.services?.[name];
  if (!svc) throw new Error(`missing services.${name}`);
  return svc;
}

// The Coolify paste-file is a self-contained copy of the reference stack's
// shared facts; this guard keeps the copies from silently rotting.
describe("deploy artifacts agree", () => {
  test("postgres image and gateway healthcheck match docker-compose.yml", async () => {
    const ref = await loadYaml(join(repoRoot, "docker-compose.yml"));
    const coolify = await loadYaml(join(deployDir, "coolify", "sprout.yaml"));

    expect(service(coolify, "postgres").image).toBe(
      service(ref, "postgres").image,
    );
    expect(service(coolify, "gateway").healthcheck).toEqual(
      service(ref, "gateway").healthcheck,
    );

    const refPg = service(ref, "postgres").healthcheck as Record<string, unknown>;
    const coolPg = service(coolify, "postgres").healthcheck as Record<string, unknown>;
    expect(String((coolPg.test as string[])[0])).toBe("CMD-SHELL");
    expect(String((coolPg.test as string[])[1])).toContain("pg_isready");
    for (const key of ["interval", "timeout", "retries"]) {
      expect(coolPg[key]).toBe(refPg[key]);
    }
  });

  test("hand-written image pins track package.json version", async () => {
    const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as {
      version: string;
    };
    const coolify = await loadYaml(join(deployDir, "coolify", "sprout.yaml"));
    expect(service(coolify, "gateway").image).toBe(
      `ghcr.io/simpros/sprout:${pkg.version}`,
    );

    const readme = await Bun.file(
      join(deployDir, "coolify", "README.md"),
    ).text();
    expect(readme).toContain(`ghcr.io/simpros/sprout:${pkg.version}`);

    const deployGuide = await Bun.file(
      join(repoRoot, "docs", "deploy.md"),
    ).text();
    for (const match of deployGuide.matchAll(
      /ghcr\.io\/simpros\/sprout:([0-9][^\s`]*)/g,
    )) {
      expect(match[1]).toBe(pkg.version);
    }
    for (const match of deployGuide.matchAll(/SPROUT_VERSION=([0-9][^\s]*)/g)) {
      expect(match[1]).toBe(pkg.version);
    }
  });
});
