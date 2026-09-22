import type { PreviewLabels } from "@sprout/preview-env";

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

export type ReservedPreviewLabel = Error & {
  manifestPath: string;
  labelKey: string;
};

export function reservedPreviewLabel(
  manifestPath: string,
  labelKey: string,
): ReservedPreviewLabel {
  return Object.assign(
    new Error(`${manifestPath} collides with a gateway label`),
    { manifestPath, labelKey },
  );
}

export function isReservedPreviewLabel(
  err: unknown,
): err is ReservedPreviewLabel {
  return (
    err instanceof Error &&
    typeof (err as { manifestPath?: unknown }).manifestPath === "string"
  );
}

export type ServiceLabelSource = {
  labels: PreviewLabels | undefined;
  index: number;
};

/**
 * Merge adopter labels over the gateway set, failing fast when an adopter
 * key would silently override a gateway-owned Traefik label. The reserved
 * set is the gateway emission itself, so it cannot drift from traefikLabels.
 * Per-service values win over preview-level ones for the same key.
 */
export function mergePreviewLabels(
  gateway: PreviewLabels,
  preview: PreviewLabels | undefined,
  service?: ServiceLabelSource,
): PreviewLabels {
  const effective = { ...preview, ...service?.labels };
  for (const key of Object.keys(effective)) {
    if (key in gateway) {
      const fromService =
        service?.labels !== undefined && key in service.labels;
      const manifestPath = fromService
        ? `preview.services[${service.index}].labels.${key}`
        : `preview.labels.${key}`;
      throw reservedPreviewLabel(manifestPath, key);
    }
  }
  return { ...gateway, ...effective };
}
