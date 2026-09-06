export type IdentityResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type PrIdResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function normalizeGitRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1];
    const path = ssh[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  const sshUrl = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(trimmed);
  if (sshUrl) {
    const host = sshUrl[1];
    const path = sshUrl[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\.git$/, "");
  }

  return null;
}

export function resolveCanonicalRepoId(input: {
  env: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
}): IdentityResult {
  const github = input.env.GITHUB_REPOSITORY?.trim();
  if (github) {
    return { ok: true, value: `https://github.com/${github}` };
  }

  const gitlab = input.env.CI_PROJECT_URL?.trim();
  if (gitlab) {
    return { ok: true, value: gitlab.replace(/\.git$/, "") };
  }

  if (input.gitRemoteUrl) {
    const normalized = normalizeGitRemoteUrl(input.gitRemoteUrl);
    if (normalized) return { ok: true, value: normalized };
  }

  return {
    ok: false,
    error:
      "cannot derive canonical repo id (set GITHUB_REPOSITORY, CI_PROJECT_URL, or git remote)",
  };
}

function positiveInt(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function resolvePrId(input: {
  env: NodeJS.ProcessEnv;
  eventPayload?: unknown;
}): PrIdResult {
  const payload = input.eventPayload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const fromPr = record.pull_request;
    if (fromPr && typeof fromPr === "object") {
      const n = positiveInt((fromPr as { number?: unknown }).number);
      if (n !== null) return { ok: true, value: n };
    }
    const fromNumber = positiveInt(record.number);
    if (fromNumber !== null) return { ok: true, value: fromNumber };
  }

  const ref = input.env.GITHUB_REF?.trim();
  if (ref) {
    const match = /^refs\/pull\/(\d+)\//.exec(ref);
    if (match) return { ok: true, value: Number(match[1]) };
  }

  const gitlab = positiveInt(input.env.CI_MERGE_REQUEST_IID);
  if (gitlab !== null) return { ok: true, value: gitlab };

  return {
    ok: false,
    error:
      "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
  };
}
