export type TraefikTls = {
  entrypoints: string;
  certResolver?: string;
};

export type TraefikForwardAuth = {
  middleware: string;
  address: string;
};

const FORWARDAUTH_RESPONSE_HEADERS =
  "Remote-User,Remote-Email,Remote-Groups";

export function traefikRouterRule(input: {
  hostname: string;
  pathPrefix?: string;
}): string {
  const host = `Host(\`${input.hostname}\`)`;
  if (!input.pathPrefix) return host;
  return `${host} && PathPrefix(\`${input.pathPrefix}\`)`;
}

export function traefikLabels(input: {
  routerName: string;
  hostname: string;
  port: number;
  pathPrefix?: string;
  tls?: TraefikTls;
  forwardAuth?: TraefikForwardAuth;
}): Record<string, string> {
  const { routerName, hostname, port, pathPrefix, tls, forwardAuth } = input;
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${routerName}.rule`]: traefikRouterRule({
      hostname,
      pathPrefix,
    }),
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
