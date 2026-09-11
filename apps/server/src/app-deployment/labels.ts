/** Traefik Docker-provider labels for a preview app container. */
export function traefikLabels(input: {
  /** Stable router/service name (typically the container name). */
  routerName: string;
  hostname: string;
  port: number;
  /**
   * Comma-separated Traefik entrypoint names (e.g. `https`, `websecure`).
   * Empty/omitted → no entrypoints label (router uses Traefik defaults).
   */
  entrypoints?: string;
  /**
   * Traefik certificate resolver name. Empty/omitted → no certresolver label
   * (plain `tls=true`, default/builtin cert).
   */
  certResolver?: string;
}): Record<string, string> {
  const { routerName, hostname, port, entrypoints, certResolver } = input;
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${routerName}.rule`]: `Host(\`${hostname}\`)`,
    [`traefik.http.routers.${routerName}.tls`]: "true",
    [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(
      port,
    ),
  };
  const entrypointsTrimmed = entrypoints?.trim() ?? "";
  if (entrypointsTrimmed !== "") {
    labels[`traefik.http.routers.${routerName}.entrypoints`] =
      entrypointsTrimmed;
  }
  const certResolverTrimmed = certResolver?.trim() ?? "";
  if (certResolverTrimmed !== "") {
    labels[`traefik.http.routers.${routerName}.tls.certresolver`] =
      certResolverTrimmed;
  }
  return labels;
}
