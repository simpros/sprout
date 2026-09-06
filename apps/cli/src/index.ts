#!/usr/bin/env bun
import { createApiClient } from "@sprout/api-client";

/** Adopter-facing URL; falls back to pre-rename `PB_GATEWAY_URL` for one release. */
export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.SPROUT_URL?.trim() ||
    env.PB_GATEWAY_URL?.trim() ||
    "http://127.0.0.1:7331"
  );
}

if (import.meta.main) {
  const baseUrl = resolveGatewayUrl();
  const [command = "health"] = process.argv.slice(2);

  const client = createApiClient(baseUrl);

  if (command === "health") {
    const response = await client.healthz.get();
    if (response.error) {
      console.error(response.error);
      process.exit(1);
    }
    console.log(JSON.stringify(response.data));
    process.exit(0);
  }

  console.error(`unknown command: ${command}`);
  process.exit(1);
}
