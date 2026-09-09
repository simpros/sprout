/**
 * Injected by `bun run compile` via `--define SPROUT_CLI_VERSION=...`
 * (from env `SPROUT_CLI_VERSION`, default `dev`). Unset when running from
 * source → "dev".
 */
declare const SPROUT_CLI_VERSION: string | undefined;

export function cliVersion(): string {
  return typeof SPROUT_CLI_VERSION !== "undefined"
    ? SPROUT_CLI_VERSION
    : "dev";
}
