import type { PreviewEnvKey, PreviewEnvMap } from "@sprout/preview-env";

/** Shared `${target}=${value}` remap: preview.env renames the canonical key. */
export function applyEnvRemap(
  fields: [string, string][],
  remap?: PreviewEnvMap,
): string[] {
  return fields.map(
    ([key, value]) => `${remap?.[key as PreviewEnvKey] ?? key}=${value}`,
  );
}
