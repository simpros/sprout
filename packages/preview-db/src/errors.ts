type WorktreeInputErrorCode =
  | "invalid_admin_url"
  | "invalid_worktree_key";

class WorktreeInputError extends Error {
  readonly code: WorktreeInputErrorCode;
  readonly value: string;

  constructor(
    code: WorktreeInputErrorCode,
    value: string,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeInputError";
    this.code = code;
    this.value = value;
  }
}

export function isWorktreeInputError(
  err: unknown,
): err is WorktreeInputError {
  return err instanceof WorktreeInputError;
}

export function throwWorktreeInputError(
  code: WorktreeInputErrorCode,
  value: string,
  message: string,
): never {
  throw new WorktreeInputError(code, value, message);
}
