/**
 * Injected by `bun build --compile --define SPROUT_CLI_VERSION=...`.
 * Unset when running from source → "dev".
 */
declare const SPROUT_CLI_VERSION: string | undefined;

export function cliVersion(): string {
  return typeof SPROUT_CLI_VERSION !== "undefined"
    ? SPROUT_CLI_VERSION
    : "dev";
}
