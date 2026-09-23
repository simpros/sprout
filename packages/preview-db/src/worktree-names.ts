const WORKTREE_OBJECT_PREFIX = "sprout_wt_";

const MAX_KEY_LEN = 40;

const WORKTREE_OBJECT_RE = /^sprout_wt_[a-z0-9_]+$/;

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
