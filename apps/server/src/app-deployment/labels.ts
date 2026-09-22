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

/**
 * Reserved key shapes without a port/hostname: key names never depend on
 * the rule value or the loadbalancer port, so dummy values suffice. Built
 * on traefikLabels so the set cannot drift from the emission.
 */
export function traefikLabelKeys(input: {
  routerName: string;
  tls?: TraefikTls;
  forwardAuth?: TraefikForwardAuth;
}): string[] {
  return Object.keys(
    traefikLabels({
      routerName: input.routerName,
      hostname: "localhost",
      port: 1,
      tls: input.tls,
      forwardAuth: input.forwardAuth,
    }),
  );
}

export type ServiceLabelSource = {
  labels: PreviewLabels | undefined;
  index: number;
};

/**
 * First collision wins: preview-level and per-service labels share one
 * effective map per container, and a service value shadows the preview
 * level for the same key. Returns the manifest path to quote, or null.
 */
export function reservedKeyCollision(
  gatewayKeys: readonly string[],
  preview: PreviewLabels | undefined,
  service?: ServiceLabelSource,
): { manifestPath: string } | null {
  const reserved = new Set(gatewayKeys);
  const effective = { ...preview, ...service?.labels };
  for (const key of Object.keys(effective)) {
    if (reserved.has(key)) {
      const fromService =
        service?.labels !== undefined && key in service.labels;
      return {
        manifestPath: fromService
          ? `preview.services[${service.index}].labels.${key}`
          : `preview.labels.${key}`,
      };
    }
  }
  return null;
}

/**
 * Pure merge of adopter labels over the gateway set. Collision rejection
 * lives in the deploy gate (resolveLabelCollisions), which runs before any
 * container exists; by the time inputs reach materialization the check has
 * already passed, so this stays total and never throws.
 * Per-service values win over preview-level ones for the same key.
 */
export function mergePreviewLabels(
  gateway: PreviewLabels,
  preview: PreviewLabels | undefined,
  service?: ServiceLabelSource,
): PreviewLabels {
  return { ...gateway, ...preview, ...service?.labels };
}
