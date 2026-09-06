export type EdenResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; body: unknown; message: string };

type EdenLike = {
  data: unknown;
  error: unknown;
  status?: number;
};

function errorBody(error: unknown): unknown {
  if (error && typeof error === "object" && "value" in error) {
    return (error as { value: unknown }).value;
  }
  return error;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return "request failed";
}

/** Unwrap one Eden/treaty response at the CLI boundary. */
export function readEden<T>(response: EdenLike): EdenResult<T> {
  const status = response.status ?? (response.error ? 500 : 200);
  if (response.error) {
    const body = errorBody(response.error);
    return {
      ok: false,
      status,
      body,
      message: errorMessage(body),
    };
  }
  return { ok: true, data: response.data as T, status };
}
