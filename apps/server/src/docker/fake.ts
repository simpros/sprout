import {
  parsePreviewContainerName,
  toCatalogContainer,
} from "../preview/naming.ts";
import type {
  CatalogContainer,
  ContainerCreateSpec,
  ContainerWaitResult,
  PreviewDocker,
} from "./port.ts";

export type FakeDockerClient = PreviewDocker & {
  pulls: string[];
  creates: ContainerCreateSpec[];
  removed: string[];
  volumesCreated: string[];
  volumesRemoved: string[];
  volumes: Set<string>;
  exposedPorts: Map<string, number | null>;
  running: Map<string, { id: string; spec: ContainerCreateSpec }>;
  ips: Map<string, Map<string, string>>;
  waitResults: Map<string, { exitCode: number } | "timeout">;
  logs: Map<string, string>;
};

export function createFakeDockerClient(
  options: {
    exposedPorts?: Record<string, number | null>;
    waitResults?: Record<string, { exitCode: number } | "timeout">;
  } = {},
): FakeDockerClient {
  const pulls: string[] = [];
  const creates: ContainerCreateSpec[] = [];
  const removed: string[] = [];
  const exposedPorts = new Map<string, number | null>(
    Object.entries(options.exposedPorts ?? {}),
  );
  const running = new Map<string, { id: string; spec: ContainerCreateSpec }>();
  const ips = new Map<string, Map<string, string>>();
  const waitResults = new Map<string, { exitCode: number } | "timeout">(
    Object.entries(options.waitResults ?? {}),
  );
  const logs = new Map<string, string>();
  const volumes = new Set<string>();
  const volumesCreated: string[] = [];
  const volumesRemoved: string[] = [];
  let nextId = 1;
  let nextIp = 1;

  return {
    pulls,
    creates,
    removed,
    volumesCreated,
    volumesRemoved,
    volumes,
    exposedPorts,
    running,
    ips,
    waitResults,
    logs,
    async pullImage(image) {
      pulls.push(image);
    },
    async firstExposedPort(image) {
      return exposedPorts.has(image) ? exposedPorts.get(image)! : null;
    },
    async removeByName(name) {
      removed.push(name);
      const prior = running.get(name);
      if (prior) ips.delete(prior.id);
      running.delete(name);
      logs.delete(name);
    },
    async createVolume(name) {
      volumesCreated.push(name);
      volumes.add(name);
    },
    async removeVolume(name) {
      volumesRemoved.push(name);
      volumes.delete(name);
    },
    async listVolumes() {
      return [...volumes];
    },
    async createAndStart(spec) {
      creates.push(spec);
      const id = `fake-${nextId++}`;
      running.set(spec.name, { id, spec });
      const netIps = new Map<string, string>();
      for (const network of spec.networkNames) {
        netIps.set(network, `10.99.0.${nextIp++}`);
      }
      ips.set(id, netIps);
      return { id };
    },
    async waitForExit(containerId, _timeoutMs): Promise<ContainerWaitResult> {
      for (const [name, { id }] of running) {
        if (id !== containerId) continue;
        const result = waitResults.get(name);
        if (result === "timeout") return { timedOut: true };
        return { timedOut: false, exitCode: result?.exitCode ?? 0 };
      }
      return { timedOut: false, exitCode: 0 };
    },
    async containerIpOnNetwork(containerId, networkName) {
      return ips.get(containerId)?.get(networkName) ?? null;
    },
    async containerLogs(nameOrId, options) {
      const byName = running.get(nameOrId);
      const name = byName
        ? nameOrId
        : [...running.entries()].find(([, v]) => v.id === nameOrId)?.[0];
      if (!name) return null;
      const text = logs.get(name) ?? "";
      if (options.tail <= 0) return "";
      const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
      return lines.slice(-options.tail).join("\n") + (lines.length > 0 ? "\n" : "");
    },
    async listPreviewContainers() {
      const out: CatalogContainer[] = [];
      for (const [name, { id }] of running) {
        const parsed = parsePreviewContainerName(name);
        if (!parsed) continue;
        out.push(toCatalogContainer(id, name, parsed));
      }
      return out;
    },
  };
}
