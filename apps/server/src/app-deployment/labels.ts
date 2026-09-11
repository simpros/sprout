/**
 * Router TLS policy for Traefik Docker labels.
 * Absent/undefined = HTTP (no tls/entrypoints/certresolver labels).
 * Present = coherent HTTPS bundle: tls + entrypoints (+ optional certresolver).
 */
export type TraefikTls = {
  /** Comma-separated Traefik entrypoint names (e.g. `https`, `websecure`). */
  entrypoints: string;
  /** Traefik certificate resolver name; omit for Traefik default/builtin cert. */
  certResolver?: string;
};

/** Traefik Docker-provider labels for a preview app container. */
export function traefikLabels(input: {
  /** Stable router/service name (typically the container name). */
  routerName: string;
  hostname: string;
  port: number;
  /** When set, emit tls + entrypoints (+ optional certresolver). */
  tls?: TraefikTls;
}): Record<string, string> {
  const { routerName, hostname, port, tls } = input;
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${routerName}.rule`]: `Host(\`${hostname}\`)`,
    [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(
      port,
    ),
  };
  if (tls) {
    labels[`traefik.http.routers.${routerName}.tls`] = "true";
    labels[`traefik.http.routers.${routerName}.entrypoints`] = tls.entrypoints;
    if (tls.certResolver !== undefined) {
      labels[`traefik.http.routers.${routerName}.tls.certresolver`] =
        tls.certResolver;
    }
  }
  return labels;
}
