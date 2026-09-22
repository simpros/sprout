import type { PreviewLabels, PreviewServiceSpec } from "@sprout/preview-env";
import {
  traefikLabelKeys,
  traefikLabels,
  type TraefikForwardAuth,
  type TraefikTls,
} from "./labels.ts";
import {
  previewContainerName,
  previewServiceContainerName,
} from "../preview/naming.ts";

export type TraefikPolicy = {
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

export type PreviewWorkloadRouting =
  | {
      kind: "routed";
      hostname: string;
      pathPrefix?: string;
      tls?: TraefikTls;
      forwardAuth?: TraefikForwardAuth;
    }
  | { kind: "internal" };

/**
 * Single seam for routing/label derivation: the app container is always
 * routed, a service is routed when it sets a hostname or path. The deploy
 * route derives its reserved sets from these same functions, so the
 * validation cannot drift from what the containers receive.
 */
export function appRouting(
  hostname: string,
  policy: TraefikPolicy,
): PreviewWorkloadRouting {
  return {
    kind: "routed",
    hostname,
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
  };
}

export function serviceRouting(
  service: Pick<PreviewServiceSpec, "hostname" | "path">,
  appHostname: string,
  policy: TraefikPolicy,
): PreviewWorkloadRouting {
  if (service.hostname == null && service.path == null) {
    return { kind: "internal" };
  }
  return {
    kind: "routed",
    hostname: service.hostname ?? appHostname,
    ...(service.path !== undefined ? { pathPrefix: service.path } : {}),
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
  };
}

export function gatewayLabels(
  name: string,
  routing: PreviewWorkloadRouting,
  port: number,
): PreviewLabels {
  if (routing.kind !== "routed") return {};
  return traefikLabels({
    routerName: name,
    hostname: routing.hostname,
    port,
    pathPrefix: routing.pathPrefix,
    tls: routing.tls,
    forwardAuth: routing.forwardAuth,
  });
}

/**
 * Key-only derivation for fail-fast validation: key names never depend on
 * the hostname, path, or port values, so callers pass no dummy sentinels.
 */
export function gatewayLabelKeys(
  name: string,
  routing: PreviewWorkloadRouting,
): string[] {
  if (routing.kind !== "routed") return [];
  return traefikLabelKeys({
    routerName: name,
    tls: routing.tls,
    forwardAuth: routing.forwardAuth,
  });
}

export function appGatewayKeys(
  slug: string,
  prId: number,
  policy: TraefikPolicy,
): string[] {
  return traefikLabelKeys({
    routerName: previewContainerName(slug, prId),
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
  });
}

export function serviceGatewayKeys(
  slug: string,
  prId: number,
  service: Pick<PreviewServiceSpec, "name" | "hostname" | "path">,
  policy: TraefikPolicy,
): string[] {
  if (service.hostname == null && service.path == null) return [];
  return traefikLabelKeys({
    routerName: previewServiceContainerName(slug, prId, service.name),
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
  });
}
