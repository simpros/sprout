/**
 * ADR exclusion policy: ADRs are maintainer internals and MUST NEVER reach
 * the consumer surface.
 *
 * Two invariants, two mechanisms:
 *
 * - Forbidden path: any artifact-relative path with an `adr` segment
 *   (case-insensitive, any extension) is a leak.
 * - Forbidden vocabulary: the standalone word `ADR`/`ADRs` (any case) in a
 *   published page body is a leak. HREF targets pointing at an ADR path are
 *   also leaks (reported as such instead of as dead links).
 */
export function isAdrPath(relPath: string): boolean {
  return relPath
    .split("/")
    .some((segment) => segment.toLowerCase() === "adr");
}

/**
 * First standalone `ADR`/`ADRs` word in page text, if any. Case-insensitive,
 * so `see ADR 0007` and `adrs` both trip. Boundaries exclude word chars AND
 * `/`, so `adr/...` path segments in raw text do NOT match here — href
 * targets are checked via `isAdrHref` and leaked ADR files via `isAdrPath`,
 * so this stays a pure vocabulary ban. Ordinary words like `address` stay
 * green via the `\w` lookarounds.
 */
export function findAdrMention(text: string): string | null {
  const match = /(?<![\w/])ADRs?(?![\w/])/i.exec(text);
  return match ? match[0]! : null;
}

/**
 * True when an extracted href points at an ADR path. Skips external targets
 * (including protocol-relative `//` URLs), mailto, and pure anchors — only
 * artifact-relative links can be ADR leaks.
 */
export function isAdrHref(href: string): boolean {
  if (
    href.startsWith("//") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  ) {
    return false;
  }
  const pathPart = href.split("#")[0]!.split("?")[0]!;
  if (!pathPart) return false;
  return isAdrPath(pathPart);
}
