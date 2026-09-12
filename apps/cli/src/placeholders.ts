/**
 * Expand `{name}` placeholders from an allow-list map.
 *
 * - Name absent from `values` → unknown (error or leave per `unknown`)
 * - Name present with `undefined` → missing value (always error)
 * - Name present with a string → replaced
 */
export function expandBracedPlaceholders(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  opts: { unknown: "error" | "leave" },
):
  | { ok: true; value: string }
  | {
      ok: false;
      failure:
        | { kind: "unknown"; match: string }
        | { kind: "missing"; name: string };
    } {
  const re = /\{([a-z_]+)\}/g;
  let failure:
    | { kind: "unknown"; match: string }
    | { kind: "missing"; name: string }
    | undefined;

  const replaced = template.replace(re, (match, name: string) => {
    if (failure) return match;
    if (!(name in values)) {
      if (opts.unknown === "error") {
        failure = { kind: "unknown", match };
      }
      return match;
    }
    const value = values[name];
    if (value === undefined) {
      failure = { kind: "missing", name };
      return match;
    }
    return value;
  });

  if (failure) return { ok: false, failure };
  return { ok: true, value: replaced };
}
