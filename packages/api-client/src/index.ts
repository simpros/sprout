import { treaty } from "@elysia/eden";
import type { SproutApi } from "@sprout/server/api-type";

export type { PreviewSnapshot } from "@sprout/server/api-type";

export type ApiClient = ReturnType<typeof treaty<SproutApi>>;

export const createApiClient = (
  baseUrl: string,
  options: { headers?: HeadersInit } = {},
) =>
  treaty<SproutApi>(baseUrl, {
    headers: options.headers,
  });
