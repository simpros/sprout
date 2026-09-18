/** Control-plane mutations serialize per (repo, prId) via an in-process queue. */
const previewLocks = new Map<string, Promise<void>>();

/** Catalog DROP/CREATE serialize per dbName so sweep cannot race provision. */
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
