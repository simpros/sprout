/** Per-host registry pull credentials and X-Registry-Auth encoding. */

export type RegistryCredential = {
  username: string;
  password: string;
};

/** Docker Hub's canonical AuthConfig serveraddress. */
const DOCKER_HUB_SERVERADDRESS = "https://index.docker.io/v1/";

/**
 * Parse `SPROUT_REGISTRY_AUTHS_JSON`:
 * `{"registry.example.com":{"user":"u","password":"p"},...}`.
 * Empty / unset → empty map. Malformed → throw (fail fast at config load).
 */
export function parseRegistryAuthsJson(
  raw: string,
): ReadonlyMap<string, RegistryCredential> {
  const trimmed = raw.trim();
  if (trimmed === "") return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid SPROUT_REGISTRY_AUTHS_JSON: must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Invalid SPROUT_REGISTRY_AUTHS_JSON: expected a JSON object of host → {user, password}",
    );
  }

  const out = new Map<string, RegistryCredential>();
  for (const [hostRaw, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const host = hostRaw.trim().toLowerCase();
    if (host === "") {
      throw new Error(
        "Invalid SPROUT_REGISTRY_AUTHS_JSON: registry host keys must be non-empty",
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${host}": expected {user, password}`,
      );
    }
    const row = entry as Record<string, unknown>;
    const user = typeof row.user === "string" ? row.user : null;
    const password = typeof row.password === "string" ? row.password : null;
    if (user === null || password === null) {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${host}": expected string fields user and password`,
      );
    }
    if (user === "" && password !== "") {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${host}": password is set but user is empty`,
      );
    }
    if (user === "") {
      // Explicit empty user = skip (anonymous for that host); ignore entry.
      continue;
    }
    out.set(host, { username: user, password });
  }
  return out;
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
    return first.toLowerCase();
  }
  return "docker.io";
}

/** AuthConfig `serveraddress` for the Engine X-Registry-Auth payload. */
export function registryServerAddress(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "docker.io" || normalized === "index.docker.io") {
    return DOCKER_HUB_SERVERADDRESS;
  }
  return host.trim();
}

/**
 * Resolve pull credentials for an image: per-host map first, then optional
 * legacy global pair. No match / empty user → undefined (anonymous pull).
 */
export function resolveRegistryAuth(
  image: string,
  auths: ReadonlyMap<string, RegistryCredential>,
  fallback?: RegistryCredential,
): { credential: RegistryCredential; serveraddress: string } | undefined {
  const host = registryHostFromImageRef(image);
  const fromMap = auths.get(host);
  const credential =
    fromMap ??
    (fallback && fallback.username !== "" ? fallback : undefined);
  if (!credential) return undefined;
  return {
    credential,
    serveraddress: registryServerAddress(host),
  };
}

/** Base64 AuthConfig for Engine `X-Registry-Auth`; empty user → omit. */
export function encodeRegistryAuthHeader(
  auth:
    | { username: string; password: string; serveraddress: string }
    | undefined,
): string | undefined {
  if (!auth || auth.username === "") return undefined;
  return Buffer.from(
    JSON.stringify({
      username: auth.username,
      password: auth.password,
      serveraddress: auth.serveraddress,
    }),
  ).toString("base64");
}

function imageNameWithoutTagOrDigest(image: string): string {
  const at = image.lastIndexOf("@");
  if (at !== -1) return image.slice(0, at);
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash) return image.slice(0, lastColon);
  return image;
}
