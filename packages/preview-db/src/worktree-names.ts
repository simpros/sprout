/** Prefix for per-worktree DB + login role names. Drop refuses anything else. */
export const WORKTREE_OBJECT_PREFIX = "sprout_wt_";

/** Shared with consumers: lowercase, non [a-z0-9-] → -, collapse, max 40. */
const MAX_KEY_LEN = 40;

/** DB/role grammar after hyphen→underscore: sprout_wt_ + [a-z0-9_]+ */
const WORKTREE_OBJECT_RE = /^sprout_wt_[a-z0-9_]+$/;

/**
 * Normalize a worktree key for consumers and object naming.
 * Distinct from adopting-repo **slug** (`[a-z][a-z0-9]*` in CONTEXT.md).
 * Empty after normalize → null.
 */
export function normalizeWorktreeKey(raw: string): string | null {
  let key = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (key.length > MAX_KEY_LEN) {
    key = key.slice(0, MAX_KEY_LEN).replace(/-+$/g, "");
  }
  return key.length > 0 ? key : null;
}

/** `sprout_wt_<key>` with hyphens folded to underscores (unquoted identifiers). */
export function worktreeObjectName(worktreeKey: string): string {
  return `${WORKTREE_OBJECT_PREFIX}${worktreeKey.replaceAll("-", "_")}`;
}

export function isWorktreeObjectName(name: string): boolean {
  return (
    name.startsWith(WORKTREE_OBJECT_PREFIX) && WORKTREE_OBJECT_RE.test(name)
  );
}

export function assertWorktreeObjectName(name: string): void {
  if (!isWorktreeObjectName(name)) {
    throw new Error(
      `refusing non-worktree name (must be ${WORKTREE_OBJECT_PREFIX}*): ${name}`,
    );
  }
}
