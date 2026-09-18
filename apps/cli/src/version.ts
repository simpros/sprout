/** Injected by `bun run compile` via `--define`; unset when running from source, so `dev`. */
declare const SPROUT_CLI_VERSION: string | undefined;

export function cliVersion(): string {
  return typeof SPROUT_CLI_VERSION !== "undefined"
    ? SPROUT_CLI_VERSION
    : "dev";
}
