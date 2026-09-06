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
};

/**
 * Preview-scoped Docker seam for app-deployment and sweep.
 * Includes catalog listing filtered to `pb-*` preview names.
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
   * IPv4 address of the container on a named Docker network, or null if not
   * attached / not yet assigned. Used for health polls on PB_POSTGRES_NETWORK.
   */
  containerIpOnNetwork(
    containerId: string,
    networkName: string,
  ): Promise<string | null>;
  listPreviewContainers(): Promise<CatalogContainer[]>;
};
