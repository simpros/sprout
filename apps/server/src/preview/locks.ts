/**
 * Serialize control-plane mutations per (repo, prId).
 * ADR 0001: one gateway process — in-process queue is the concurrency design.
 * ponytail: global Map; upgrade to shared lock if multi-process ever lands.
 */
const previewLocks = new Map<string, Promise<void>>();

/**
 * Serialize catalog DROP/CREATE per dbName so orphan sweep cannot race provision.
 * Taken inside the (repo, prId) lock for lifecycle paths; alone for orphan drops.
 */
const dbNameLocks = new Map<string, Promise<void>>();

function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(previewLocks, `${repo}\0${prId}`, fn);
}

export function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(dbNameLocks, dbName, fn);
}
