import { describe, expect, test } from "bun:test";
import {
  previewContainerName,
  previewServiceContainerName,
} from "../preview/naming.ts";
import {
  appGatewayKeys,
  appRouting,
  gatewayLabelKeys,
  gatewayLabels,
  serviceGatewayKeys,
  serviceRouting,
} from "./workload-labels.ts";

const policy = {
  traefikTls: { entrypoints: "websecure", certResolver: "myresolver" },
  traefikForwardAuth: {
    middleware: "voidauth",
    address: "https://auth.example.com/api/authz/forward-auth",
  },
};

describe("workload-labels", () => {
  test("app reserved keys match the materialized gateway emission", () => {
    const routing = appRouting("pr-42.example.com", policy);
    expect(
      appGatewayKeys("myapp", 42, policy).sort(),
    ).toEqual(
      Object.keys(gatewayLabels(previewContainerName("myapp", 42), routing, 3000)).sort(),
    );
  });

  test("unrouted services reserve no keys; routed ones match the emission", () => {
    expect(
      serviceGatewayKeys(
        "myapp",
        42,
        { name: "worker" },
        policy,
      ),
    ).toEqual([]);
    for (const service of [
      { name: "api", hostname: "api.example.com" },
      { name: "admin", path: "/admin" },
    ]) {
      const routing = serviceRouting(service, "pr-42.example.com", policy);
      expect(routing.kind).toBe("routed");
      expect(
        serviceGatewayKeys("myapp", 42, service, policy).sort(),
      ).toEqual(
        Object.keys(
          gatewayLabels(
            previewServiceContainerName("myapp", 42, service.name),
            routing,
            4000,
          ),
        ).sort(),
      );
    }
  });

  test("gatewayLabelKeys needs no port: keys are port-independent", () => {
    const routing = appRouting("pr-42.example.com", policy);
    expect(gatewayLabelKeys("r", routing)).toEqual(
      Object.keys(gatewayLabels("r", routing, 1)),
    );
    expect(gatewayLabelKeys("r", routing)).toEqual(
      Object.keys(gatewayLabels("r", routing, 65535)),
    );
    expect(gatewayLabelKeys("r", { kind: "internal" })).toEqual([]);
  });
});
