export type RegistryCredential = {
  username: string;
  password: string;
};

export type RegistryPullAuth = {
  byHost: ReadonlyMap<string, RegistryCredential>;
  fallback?: RegistryCredential;
};

export type RegistryAuthConfig = {
  username: string;
  password: string;
  serveraddress: string;
};

const DOCKER_HUB_SERVERADDRESS = "https://index.docker.io/v1/";

export function canonicalizeRegistryHost(host: string): string {
  let h = host.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "");
  const slash = h.indexOf("/");
  if (slash !== -1) h = h.slice(0, slash);
  if (
    h === "docker.io" ||
    h === "index.docker.io" ||
    h === "registry-1.docker.io"
  ) {
    return "docker.io";
  }
  return h;
}

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
      "Invalid SPROUT_REGISTRY_AUTHS_JSON: expected a JSON object of host → {username, password}",
    );
  }

  const out = new Map<string, RegistryCredential>();
  const rawKeyByHost = new Map<string, string>();
  for (const [hostRaw, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const host = canonicalizeRegistryHost(hostRaw);
    if (host === "") {
      throw new Error(
        "Invalid SPROUT_REGISTRY_AUTHS_JSON: registry host keys must be non-empty",
      );
    }
    const priorRaw = rawKeyByHost.get(host);
    if (priorRaw !== undefined) {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON: duplicate registry host "${host}" (keys "${priorRaw}" and "${hostRaw}")`,
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${hostRaw}": expected {username, password}`,
      );
    }
    const row = entry as Record<string, unknown>;
    const username =
      typeof row.username === "string" ? row.username : null;
    const password = typeof row.password === "string" ? row.password : null;
    if (username === null || password === null) {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${hostRaw}": expected string fields username and password`,
      );
    }
    if (username === "") {
      throw new Error(
        `Invalid SPROUT_REGISTRY_AUTHS_JSON entry for "${hostRaw}": username must be non-empty (omit the host for anonymous)`,
      );
    }
    rawKeyByHost.set(host, hostRaw);
    out.set(host, { username, password });
  }
  return out;
}

export function buildRegistryPullAuth(input: {
  authsJson: string;
  legacyUser: string;
  legacyPassword: string;
}): RegistryPullAuth {
  if (input.legacyPassword !== "" && input.legacyUser === "") {
    throw new Error(
      "SPROUT_REGISTRY_PASSWORD is set but SPROUT_REGISTRY_USER is empty",
    );
  }
  const byHost = parseRegistryAuthsJson(input.authsJson);
  return {
    byHost,
    ...(input.legacyUser !== ""
      ? {
          fallback: {
            username: input.legacyUser,
            password: input.legacyPassword,
          },
        }
      : {}),
  };
}

export function imageNameWithoutTagOrDigest(image: string): string {
  const at = image.lastIndexOf("@");
  if (at !== -1) return image.slice(0, at);
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash) return image.slice(0, lastColon);
  return image;
}

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

export function registryServerAddress(host: string): string {
  if (canonicalizeRegistryHost(host) === "docker.io") {
    return DOCKER_HUB_SERVERADDRESS;
  }
  return host.trim();
}

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

export function encodeRegistryAuthHeader(auth: RegistryAuthConfig): string {
  return Buffer.from(JSON.stringify(auth)).toString("base64");
}

export function xRegistryAuthHeader(
  image: string,
  store: RegistryPullAuth,
): string | undefined {
  const auth = resolveRegistryAuth(image, store);
  return auth ? encodeRegistryAuthHeader(auth) : undefined;
}
