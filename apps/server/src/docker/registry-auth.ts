/** Per-host registry pull credentials and X-Registry-Auth encoding. */

export type RegistryCredential = {
  username: string;
  password: string;
};

/**
 * Boot-normalized pull auth: per-host map + optional legacy global fallback.
 * Built at `loadConfig`; Engine looks up `byHost.get(host) ?? fallback`.
 */
export type RegistryPullAuth = {
  byHost: ReadonlyMap<string, RegistryCredential>;
  /** Only set when legacy SPROUT_REGISTRY_USER is non-empty. */
  fallback?: RegistryCredential;
};

/** AuthConfig fields for Engine X-Registry-Auth. */
export type RegistryAuthConfig = {
  username: string;
  password: string;
  serveraddress: string;
};

/** Docker Hub's canonical AuthConfig serveraddress. */
const DOCKER_HUB_SERVERADDRESS = "https://index.docker.io/v1/";

/**
 * Collapse Docker Hub synonyms to `docker.io` so map keys and image-ref
 * lookup share one host identity.
 */
export function canonicalizeRegistryHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h === "index.docker.io" || h === "registry-1.docker.io") return "docker.io";
  return h;
}

/**
 * Strip tag or digest from an image ref (`ghcr.io/org/app:tag` → `ghcr.io/org/app`).
 * Shared by host extraction and Engine `/images/create` query construction.
 */
export function imageNameWithoutTagOrDigest(image: string): string {
  const at = image.lastIndexOf("@");
  if (at !== -1) return image.slice(0, at);
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash) return image.slice(0, lastColon);
  return image;
}

/**
 * Registry host for an image ref (`ghcr.io/org/app:tag` → `ghcr.io`).
 * Short names / docker hub paths → `docker.io`.
 */
export function registryHostFromImageRef(image: string): string {
  const name = imageNameWithoutTagOrDigest(image);
  const slash = name.indexOf("/");
  const first = slash === -1 ? name : name.slice(0, slash);
  if (
    first.includes(".") ||
    first.includes(":") ||
    first.toLowerCase() === "localhost"
  ) {
    return canonicalizeRegistryHost(first);
  }
  return "docker.io";
}

/** AuthConfig `serveraddress` for the Engine X-Registry-Auth payload. */
export function registryServerAddress(host: string): string {
  if (canonicalizeRegistryHost(host) === "docker.io") {
    return DOCKER_HUB_SERVERADDRESS;
  }
  return host.trim();
}

/**
 * Resolve pull AuthConfig for an image: per-host map first, then optional
 * legacy fallback. No match → undefined (anonymous pull).
 */
export function resolveRegistryAuth(
  image: string,
  store: RegistryPullAuth,
): RegistryAuthConfig | undefined {
  const host = registryHostFromImageRef(image);
  const credential = store.byHost.get(host) ?? store.fallback;
  if (!credential) return undefined;
  return {
    username: credential.username,
    password: credential.password,
    serveraddress: registryServerAddress(host),
  };
}

/** Base64 AuthConfig for Engine `X-Registry-Auth`. */
export function encodeRegistryAuthHeader(auth: RegistryAuthConfig): string {
  return Buffer.from(JSON.stringify(auth)).toString("base64");
}

/** Resolve + encode in one step for Engine pull. */
export function xRegistryAuthHeader(
  image: string,
  store: RegistryPullAuth,
): string | undefined {
  const auth = resolveRegistryAuth(image, store);
  return auth ? encodeRegistryAuthHeader(auth) : undefined;
}
