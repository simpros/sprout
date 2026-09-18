import { forgeApiError } from "./types.ts";

export function finiteIdsFromArray(
  body: unknown,
  field: "number" | "iid",
): number[] {
  if (!Array.isArray(body)) {
    throw forgeApiError(
      field === "number"
        ? "GitHub open-PR list returned non-array payload"
        : "GitLab open-MR list returned non-array payload",
      502,
    );
  }

  const ids: number[] = [];
  let anyInvalid = false;
  for (const item of body) {
    const n =
      item !== null && typeof item === "object" && field in item
        ? (item as Record<string, unknown>)[field]
        : undefined;
    if (typeof n === "number" && Number.isFinite(n)) {
      ids.push(n);
    } else {
      anyInvalid = true;
    }
  }

  if (body.length > 0 && (ids.length === 0 || anyInvalid)) {
    throw forgeApiError(
      field === "number"
        ? "GitHub open-PR list returned unparsable PR ids"
        : "GitLab open-MR list returned unparsable MR iids",
      502,
    );
  }

  return ids;
}
