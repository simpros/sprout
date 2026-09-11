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

/**
 * ForwardAuth middleware policy for Traefik Docker labels.
 * Absent/undefined = no middleware attachment or definition labels.
 * Present = one router middleware attachment + matching forwardAuth definition
 * (Coolify docker-provider only — no Traefik file/static config).
 */
export type TraefikForwardAuth = {
  /** Single Traefik middleware name attached to the router (e.g. `voidauth`). */
  middleware: string;
  /** ForwardAuth URL Traefik must reach (operator SSO, e.g. VoidAuth). */
  address: string;
};

const FORWARDAUTH_RESPONSE_HEADERS =
  "Remote-User,Remote-Email,Remote-Groups";

/** Traefik Docker-provider labels for a preview app container. */
export function traefikLabels(input: {
  /** Stable router/service name (typically the container name). */
  routerName: string;
  hostname: string;
  port: number;
  /** When set, emit tls + entrypoints (+ optional certresolver). */
  tls?: TraefikTls;
  /** When set, emit middleware attachment + forwardAuth definition. */
  forwardAuth?: TraefikForwardAuth;
}): Record<string, string> {
  const { routerName, hostname, port, tls, forwardAuth } = input;
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
  if (forwardAuth) {
    const { middleware, address } = forwardAuth;
    labels[`traefik.http.routers.${routerName}.middlewares`] = middleware;
    labels[`traefik.http.middlewares.${middleware}.forwardauth.address`] =
      address;
    labels[
      `traefik.http.middlewares.${middleware}.forwardauth.trustForwardHeader`
    ] = "true";
    labels[
      `traefik.http.middlewares.${middleware}.forwardauth.authResponseHeaders`
    ] = FORWARDAUTH_RESPONSE_HEADERS;
  }
  return labels;
}
