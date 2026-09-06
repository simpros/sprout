import { parsePreviewContainerName } from "../preview/naming.ts";
import type {
  CatalogContainer,
  ContainerCreateSpec,
  PreviewDocker,
} from "./port.ts";

export type FakeDockerClient = PreviewDocker & {
  pulls: string[];
  creates: ContainerCreateSpec[];
  removed: string[];
  /** Image → first exposed port; unset images return null. */
  exposedPorts: Map<string, number | null>;
  running: Map<string, { id: string; spec: ContainerCreateSpec }>;
  /** containerId → networkName → IP */
  ips: Map<string, Map<string, string>>;
};

export function createFakeDockerClient(
  options: {
    exposedPorts?: Record<string, number | null>;
    /** Network that receives sequential fake IPs (default: first network on create). */
    postgresNetwork?: string;
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
  let nextId = 1;
  let nextIp = 1;
  const postgresNetwork = options.postgresNetwork;

  return {
    pulls,
    creates,
    removed,
    exposedPorts,
    running,
    ips,
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
    },
    async createAndStart(spec) {
      creates.push(spec);
      const id = `fake-${nextId++}`;
      running.set(spec.name, { id, spec });
      const netIps = new Map<string, string>();
      for (const network of spec.networkNames) {
        if (postgresNetwork && network !== postgresNetwork) continue;
        netIps.set(network, `10.99.0.${nextIp++}`);
      }
      ips.set(id, netIps);
      return { id };
    },
    async containerIpOnNetwork(containerId, networkName) {
      return ips.get(containerId)?.get(networkName) ?? null;
    },
    async listPreviewContainers() {
      const out: CatalogContainer[] = [];
      for (const [name, { id }] of running) {
        const parsed = parsePreviewContainerName(name);
        if (!parsed) continue;
        out.push({
          containerId: id,
          containerName: name,
          slug: parsed.slug,
          prId: parsed.prId,
        });
      }
      return out;
    },
  };
}
