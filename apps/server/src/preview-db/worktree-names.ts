/** Prefix for per-worktree DB + login role names. Drop refuses anything else. */
export const WORKTREE_OBJECT_PREFIX = "sprout_wt_";

/** Shared with consumers: lowercase, non [a-z0-9-] → -, collapse, max 40. */
const MAX_SLUG_LEN = 40;

/** DB/role grammar after hyphen→underscore: sprout_wt_ + [a-z0-9_]+ */
const WORKTREE_OBJECT_RE = /^sprout_wt_[a-z0-9_]+$/;

/**
 * Normalize a worktree slug for consumers and object naming.
 * Empty after normalize → null.
 */
export function normalizeWorktreeSlug(raw: string): string | null {
  let slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG_LEN) {
    slug = slug.slice(0, MAX_SLUG_LEN).replace(/-+$/g, "");
  }
  return slug.length > 0 ? slug : null;
}

/** `sprout_wt_<slug>` with hyphens folded to underscores (unquoted identifiers). */
export function worktreeObjectName(slug: string): string {
  return `${WORKTREE_OBJECT_PREFIX}${slug.replaceAll("-", "_")}`;
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
