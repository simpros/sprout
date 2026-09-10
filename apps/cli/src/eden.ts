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

function bodyDetail(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = String((body as { error: unknown }).error);
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim() !== "") {
      return `${error}: ${detail.trim()}`;
    }
    return error;
  }
  if (typeof body === "string" && body.trim() !== "") {
    return body.trim().slice(0, 500);
  }
  if (body != null) {
    try {
      const raw = JSON.stringify(body);
      if (raw && raw !== "{}") return raw.slice(0, 500);
    } catch {
      // ignore
    }
  }
  return "request failed";
}

/** Unwrap one Eden/treaty response at the CLI boundary. Non-2xx is always failure. */
export function readEden<T = unknown>(response: EdenLike): EdenResult<T> {
  const status = response.status ?? (response.error ? 500 : 200);
  if (response.error || status >= 400) {
    const body = response.error
      ? errorBody(response.error)
      : response.data;
    return {
      ok: false,
      status,
      body,
      message: `${status} ${bodyDetail(body)}`,
    };
  }
  return {
    ok: true,
    data: response.data as T,
    status,
  };
}
