export type WorktreeInputErrorCode =
  | "invalid_admin_url"
  | "invalid_worktree_key";

export type WorktreeInputError = Error & {
  code: WorktreeInputErrorCode;
  value: string;
};

export function isWorktreeInputError(
  err: unknown,
): err is WorktreeInputError {
  if (!(err instanceof Error) || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === "invalid_admin_url" || code === "invalid_worktree_key";
}

export function throwWorktreeInputError(
  code: WorktreeInputErrorCode,
  value: string,
  message: string,
): never {
  const err = new Error(message) as WorktreeInputError;
  err.code = code;
  err.value = value;
  throw err;
}
