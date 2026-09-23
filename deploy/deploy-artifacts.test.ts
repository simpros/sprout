import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_REQUIRED_ENV,
  REQUIRED_ENV,
} from "../apps/server/src/config.ts";
// Derived, not listed: docs pages move between files, so a hand list of
// docs paths would shed this guard on the next content move.
import { docsPages } from "../docs/site/assemble.ts";

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(deployDir, "..");
const coolifyComposePath = join(deployDir, "coolify", "gateway.compose.yml");

type ComposeHealthcheck = {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
};

type ComposeService = {
  image?: string;
  healthcheck?: ComposeHealthcheck;
  expose?: string[];
  environment?: string[] | Record<string, string | null | undefined>;
  depends_on?: Record<string, { condition?: string }>;
};

type ComposeDoc = {
  services?: Record<string, ComposeService>;
};

async function loadYaml(path: string): Promise<ComposeDoc> {
  const text = await Bun.file(path).text();
  return Bun.YAML.parse(text) as ComposeDoc;
}

function service(doc: ComposeDoc, name: string): ComposeService {
  const svc = doc.services?.[name];
  if (!svc) throw new Error(`missing services.${name}`);
  return svc;
}

function envValue(
  env: ComposeService["environment"],
  key: string,
): string | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const entry = env.find((e) => e === key || e.startsWith(`${key}=`));
    if (!entry) return undefined;
    const sep = entry.indexOf("=");
    return sep === -1 ? "" : entry.slice(sep + 1);
  }
  const value = env[key];
  return value === null || value === undefined ? undefined : String(value);
}

// Reference compose spells values as ${VAR:-default} templates; the Coolify
// paste-file hardcodes the resolved default, so compare against the default.
function referenceDefault(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const match = raw.match(/\$\{[^:}]+:-(.*?)\}$/);
  return match ? match[1] : raw;
}

// The Coolify paste-file is a self-contained copy of the reference stack's
// shared facts; this guard keeps the copies from silently rotting.
describe("deploy artifacts agree", () => {
  test("postgres image and gateway healthcheck match docker-compose.yml", async () => {
    const ref = await loadYaml(join(repoRoot, "docker-compose.yml"));
    const coolify = await loadYaml(coolifyComposePath);

    expect(service(coolify, "postgres").image).toBe(
      service(ref, "postgres").image,
    );
    expect(service(coolify, "gateway").healthcheck).toEqual(
      service(ref, "gateway").healthcheck,
    );

    const refPg = service(ref, "postgres").healthcheck;
    const coolPg = service(coolify, "postgres").healthcheck;
    expect(coolPg?.test[0]).toBe("CMD-SHELL");
    expect(coolPg?.test[1]).toContain("pg_isready");
    for (const key of ["interval", "timeout", "retries"] as const) {
      expect(coolPg?.[key]).toBe(refPg?.[key]);
    }
  });

  test("coolify gateway carries every required gateway env key non-empty", async () => {
    const coolify = await loadYaml(coolifyComposePath);
    const env = service(coolify, "gateway").environment;
    for (const key of [...REQUIRED_ENV, ...POSTGRES_REQUIRED_ENV]) {
      const value = envValue(env, key);
      expect(typeof value === "string" && value.trim() !== "").toBe(true);
    }
  });

  test("coolify healthcheck URL port equals the exposed port", async () => {
    const coolify = await loadYaml(coolifyComposePath);
    const gateway = service(coolify, "gateway");
    const exposed = gateway.expose?.[0];
    const probe = gateway.healthcheck?.test.join(" ") ?? "";
    const match = probe.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    expect(exposed).toBeDefined();
    expect(match?.[1]).toBe(exposed);
  });

  test("coolify gateway waits on healthy postgres", async () => {
    const coolify = await loadYaml(coolifyComposePath);
    expect(service(coolify, "gateway").depends_on?.postgres?.condition).toBe(
      "service_healthy",
    );
  });

  test("coolify pg host/port/user equal the reference defaults", async () => {
    const ref = await loadYaml(join(repoRoot, "docker-compose.yml"));
    const coolify = await loadYaml(coolifyComposePath);
    const refEnv = service(ref, "gateway").environment;
    const coolEnv = service(coolify, "gateway").environment;
    for (const key of ["SPROUT_PG_HOST", "SPROUT_PG_PORT", "SPROUT_PG_USER"]) {
      expect(envValue(coolEnv, key)).toBe(referenceDefault(envValue(refEnv, key)));
    }
  });

  test("hand-written version pins track package.json version", async () => {
    const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as {
      version: string;
    };
    const coolify = await loadYaml(coolifyComposePath);
    expect(service(coolify, "gateway").image).toBe(
      `ghcr.io/simpros/sprout:${pkg.version}`,
    );

    // Every hand-written copy of the release pin lives in this list, plus
    // every published docs page (derived from the manifest so a content
    // move cannot shed the guard). Scan for any version token so a new pin
    // shape cannot slip past the guard; the only allowed foreign tokens
    // are named in versionExceptions below.
    const pinFiles = [
      "Dockerfile",
      "deploy/coolify/gateway.compose.yml",
      "deploy/coolify/README.md",
      "examples/adopting-repo/.github/workflows/sprout.yml",
      "examples/adopting-repo/.gitlab-ci.yml",
      "templates/README.md",
    ];
    // Docs pages carry pins too, but most pages carry none — so they are
    // scanned for stray pins without requiring each page to have one.
    const docsFiles = docsPages.map((p) => p.file);
    const versionToken = /(?<![\d.])v?(\d+\.\d+\.\d+)(?![\d.])/g;
    // Deliberate foreign versions, not sprout release pins. Each exception
    // names a marker sharing the token's line, so the same token elsewhere
    // in the file still fails.
    const versionExceptions = [
      // Bun base image, tracks the toolchain not the release.
      { file: "Dockerfile", version: "1.4.0", marker: "oven/bun" },
      // Same Bun base mention in the build example.
      { file: "docs/operator-deploy.md", version: "1.4.0", marker: "Bun" },
      // Illustrative older tag in the inputs table.
      { file: "templates/README.md", version: "0.6.0", marker: "e.g." },
    ];
    async function unexcusedPins(rel: string): Promise<string[]> {
      const text = await Bun.file(join(repoRoot, rel)).text();
      const pins: string[] = [];
      for (const line of text.split("\n")) {
        for (const match of line.matchAll(versionToken)) {
          const pin = match[1];
          const excused = versionExceptions.some(
            (e) => e.file === rel && e.version === pin && line.includes(e.marker),
          );
          if (!excused) pins.push(pin);
        }
      }
      return pins;
    }
    for (const rel of pinFiles) {
      const pins = await unexcusedPins(rel);
      expect(pins.length).toBeGreaterThan(0);
      for (const pin of pins) {
        expect(pin).toBe(pkg.version);
      }
    }
    for (const rel of docsFiles) {
      for (const pin of await unexcusedPins(rel)) {
        expect(`${rel}: ${pin}`).toBe(`${rel}: ${pkg.version}`);
      }
    }
  });
});
