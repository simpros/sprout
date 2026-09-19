export const RESET_MARKER_MAX_LENGTH = 256;

const RESET_MARKER_FORBIDDEN_RE = /[<>\r\n]/;

/** Trimmed marker token, or null when empty, oversize, or carrying markup. */
export function parseResetMarkerToken(raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  if (token.length > RESET_MARKER_MAX_LENGTH) return null;
  if (RESET_MARKER_FORBIDDEN_RE.test(token)) return null;
  return token;
}
