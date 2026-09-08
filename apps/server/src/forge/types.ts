export type ForgeClient = {
  listOpenPrIds(canonicalRepoId: string): Promise<number[]>;
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ForgeApiError = Error & {
  name: "ForgeApiError";
  status: number;
};

export function forgeApiError(message: string, status: number): ForgeApiError {
  const error = new Error(message) as ForgeApiError;
  error.name = "ForgeApiError";
  error.status = status;
  return error;
}

export function isForgeApiError(error: unknown): error is ForgeApiError {
  return error instanceof Error && error.name === "ForgeApiError";
}
