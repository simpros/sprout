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
 * Present = router middlewares + forwardAuth definition for each name
 * (Coolify docker-provider only — no Traefik file/static config).
 */
export type TraefikForwardAuth = {
  /** Comma-separated middleware names attached to the router (e.g. `voidauth`). */
  middlewares: string;
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
  /** When set, emit middleware attachment + forwardAuth definitions. */
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
    labels[`traefik.http.routers.${routerName}.middlewares`] =
      forwardAuth.middlewares;
    for (const name of forwardAuth.middlewares.split(",")) {
      const mw = name.trim();
      if (mw === "") continue;
      labels[`traefik.http.middlewares.${mw}.forwardauth.address`] =
        forwardAuth.address;
      labels[
        `traefik.http.middlewares.${mw}.forwardauth.trustForwardHeader`
      ] = "true";
      labels[
        `traefik.http.middlewares.${mw}.forwardauth.authResponseHeaders`
      ] = FORWARDAUTH_RESPONSE_HEADERS;
    }
  }
  return labels;
}
