// ADRs are maintainer internals and must never reach the consumer surface.
export function isAdrPath(relPath: string): boolean {
  return relPath
    .split("/")
    .some((segment) => segment.toLowerCase() === "adr");
}

// Boundaries exclude `/` so `adr/` path segments never match as vocabulary.
export function findAdrMention(text: string): string | null {
  const match = /(?<![\w/])ADRs?(?![\w/])/i.exec(text);
  return match ? match[0]! : null;
}

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
