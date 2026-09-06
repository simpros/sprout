import { treaty } from "@elysia/eden";
import type { SproutApi } from "@sprout/server/api-type";

export type { SproutApi } from "@sprout/server/api-type";

export type ApiClient = ReturnType<typeof treaty<SproutApi>>;

export type ApiClientOptions = {
  headers?: HeadersInit;
};

export const createApiClient = (
  baseUrl: string,
  options: ApiClientOptions = {},
) =>
  treaty<SproutApi>(baseUrl, {
    headers: options.headers,
  });
