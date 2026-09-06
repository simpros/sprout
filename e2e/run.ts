#!/usr/bin/env bun
/**
 * Bring up the e2e compose stack, run smoke tests, tear down.
 *
 *   bun run test:e2e
 *
 * Requires Docker. Asserts compose smoke only (admin mint deploy token).
 * Lifecycle/sweep placeholders: see e2e/lifecycle.test.ts, e2e/sweep.test.ts
 * and tickets #25 / #28 / #30 / #31.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSE_E2E_ENV_PATH } from "./harness/config.ts";
import {
  composeDown,
  composeUp,
  waitForGateway,
} from "./harness/stack.ts";

const e2eDir = dirname(fileURLToPath(import.meta.url));

/** Docker-bound tests exceed Bun's 5s default. */
const E2E_TEST_TIMEOUT_MS = "180000";

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function requireComposeEnv(
  env: Record<string, string>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`e2e/compose.e2e.env missing required key ${key}`);
  }
  return value;
}

async function main() {
  const composeEnv = parseEnvFile(COMPOSE_E2E_ENV_PATH);
  const gatewayHostPort = requireComposeEnv(composeEnv, "SPROUT_GATEWAY_HOST_PORT");
  const adminToken = requireComposeEnv(composeEnv, "SPROUT_ADMIN_TOKEN");
  const gatewayUrl = `http://127.0.0.1:${gatewayHostPort}`;

  process.env.SPROUT_E2E_GATEWAY_URL = gatewayUrl;
  process.env.SPROUT_E2E_ADMIN_TOKEN = adminToken;

  console.log("e2e: composing stack down (clean slate)…");
  await composeDown();

  console.log("e2e: composing stack up…");
  await composeUp();

  let code = 0;
  try {
    console.log("e2e: waiting for gateway…");
    await waitForGateway(180_000);

    console.log("e2e: running bun test…");
    const proc = Bun.spawn({
      cmd: ["bun", "test", "--timeout", E2E_TEST_TIMEOUT_MS, e2eDir],
      cwd: join(e2eDir, ".."),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        SPROUT_E2E_MANAGED: "1",
        SPROUT_E2E_GATEWAY_URL: gatewayUrl,
        SPROUT_E2E_ADMIN_TOKEN: adminToken,
      },
    });
    code = await proc.exited;
  } finally {
    console.log("e2e: composing stack down…");
    await composeDown();
  }
  if (code !== 0) process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
