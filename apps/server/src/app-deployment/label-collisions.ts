import type {
  PreviewLabels,
  PreviewServiceSpec,
} from "@sprout/preview-env";
import {
  previewContainerName,
  previewServiceContainerName,
} from "../preview/naming.ts";
import { reservedKeyCollision } from "./labels.ts";
import {
  appRouting,
  gatewayLabelKeys,
  serviceRouting,
  type TraefikPolicy,
} from "./workload-labels.ts";

/**
 * Fail fast when an adopter label would silently override a gateway-owned
 * Traefik label. The reserved sets are built from the same appRouting /
 * serviceRouting / gatewayLabelKeys seam the containers materialize from,
 * so validation cannot drift from the gateway's TLS and forwardAuth policy.
 */
export function resolveLabelCollisions(input: {
  slug: string;
  prId: number;
  hostname: string;
  labels: PreviewLabels | undefined;
  services: PreviewServiceSpec[] | undefined;
  policy: TraefikPolicy;
}): { ok: true } | { ok: false; error: string; detail: string } {
  const appHit = reservedKeyCollision(
    gatewayLabelKeys(
      previewContainerName(input.slug, input.prId),
      appRouting(input.hostname, input.policy),
    ),
    input.labels,
  );
  if (appHit) {
    return {
      ok: false,
      error: "reserved_preview_label",
      detail: `${appHit.manifestPath} collides with a gateway label`,
    };
  }
  for (const [index, service] of (input.services ?? []).entries()) {
    const hit = reservedKeyCollision(
      gatewayLabelKeys(
        previewServiceContainerName(input.slug, input.prId, service.name),
        serviceRouting(service, input.hostname, input.policy),
      ),
      input.labels,
      { labels: service.labels, index },
    );
    if (hit) {
      return {
        ok: false,
        error: "reserved_preview_label",
        detail: `${hit.manifestPath} collides with a gateway label`,
      };
    }
  }
  return { ok: true };
}
