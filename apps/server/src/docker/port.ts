export type CatalogContainer =
  | {
      containerId: string;
      containerName: string;
      slug: string;
      prId: number;
      kind: "app";
    }
  | {
      containerId: string;
      containerName: string;
      slug: string;
      prId: number;
      kind: "service";
      serviceName: string;
    };

export type ContainerCreateSpec = {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  networkNames: string[];
  cmd?: string[];
};

export type ContainerWaitResult =
  | { timedOut: false; exitCode: number }
  | { timedOut: true };

export type PreviewDocker = {
  pullImage(image: string): Promise<void>;
  firstExposedPort(image: string): Promise<number | null>;
  removeByName(name: string): Promise<void>;
  createAndStart(spec: ContainerCreateSpec): Promise<{ id: string }>;
  waitForExit(
    containerId: string,
    timeoutMs: number,
  ): Promise<ContainerWaitResult>;
  containerIpOnNetwork(
    containerId: string,
    networkName: string,
  ): Promise<string | null>;
  containerLogs(
    nameOrId: string,
    options: { tail: number },
  ): Promise<string | null>;
  listPreviewContainers(): Promise<CatalogContainer[]>;
};
