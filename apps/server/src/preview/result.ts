export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; detail?: string };
