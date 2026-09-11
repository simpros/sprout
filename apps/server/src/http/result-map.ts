import type { AuthContext } from "../auth/middleware.ts";
import type { Result } from "../preview/result.ts";

/** Deploy-token repo gate shared by lifecycle HTTP handlers. */
export function resolveRepo(
  auth: AuthContext,
  requested: string,
): Result<string> {
  if (auth.scope === "deploy" && auth.canonicalRepoId !== requested) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, value: requested };
}

/** Map a domain `Result` onto Elysia's `set.status` + error body. */
export function mapResult<T>(
  result: Result<T>,
  set: { status?: number | string },
): T | { error: string; detail?: string } {
  if (!result.ok) {
    set.status = result.status;
    return result.detail !== undefined
      ? { error: result.error, detail: result.detail }
      : { error: result.error };
  }
  return result.value;
}
