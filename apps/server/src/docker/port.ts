export type CatalogContainer = {
  containerId: string;
  containerName: string;
  slug: string;
  prId: number;
};

/** Spec for creating a preview (or other) container via the Docker engine. */
export type ContainerCreateSpec = {
  name: string;
  image: string;
  /** `KEY=VALUE` entries — app containers get only the five PG* vars. */
  env: string[];
  labels: Record<string, string>;
  /** All networks attached via create-time EndpointsConfig. */
  networkNames: string[];
  /**
   * Optional Docker Cmd (replaces image CMD, not ENTRYPOINT).
   * Omit entirely to keep the image default CMD; never set Entrypoint here.
   */
  cmd?: string[];
};

export type ContainerWaitResult =
  | { timedOut: false; exitCode: number }
  | { timedOut: true };

/**
 * Preview-scoped Docker seam for app-deployment and sweep.
 * Includes catalog listing filtered to `sprout-*` preview names.
 * Tests use a fake; production uses the unix-socket engine client.
 */
export type PreviewDocker = {
  pullImage(image: string): Promise<void>;
  /** First EXPOSE port from the image config, or null if none. */
  firstExposedPort(image: string): Promise<number | null>;
  /** Force-remove by container name; 404 is success. */
  removeByName(name: string): Promise<void>;
  createAndStart(spec: ContainerCreateSpec): Promise<{ id: string }>;
  /**
   * Block until the container exits or `timeoutMs` elapses.
   * Used for one-shot seed image runs.
   */
  waitForExit(
    containerId: string,
    timeoutMs: number,
  ): Promise<ContainerWaitResult>;
  /**
   * IPv4 address of the container on a named Docker network, or null if not
   * attached / not yet assigned. Used for health polls on SPROUT_POSTGRES_NETWORK.
   */
  containerIpOnNetwork(
    containerId: string,
    networkName: string,
  ): Promise<string | null>;
  listPreviewContainers(): Promise<CatalogContainer[]>;
};
