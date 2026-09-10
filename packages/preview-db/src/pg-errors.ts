/** Match Postgres driver errors by SQLSTATE and/or message. */
export function pgErrorMatches(
  err: unknown,
  opts: { codes: string[]; messageRe?: RegExp },
): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (opts.codes.includes(code)) return true;
  if (!opts.messageRe) return false;
  const message = "message" in err ? String(err.message) : String(err);
  return opts.messageRe.test(message);
}

export function isDuplicateDatabase(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42P04"],
    messageRe: /already exists/i,
  });
}

export function isDuplicateRole(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42710"],
    messageRe: /already exists/i,
  });
}

export function isInsufficientPrivilege(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42501"],
    messageRe: /permission denied|must be superuser|must have createrole/i,
  });
}
