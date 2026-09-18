const UNAMBIGUOUS_UTC_INSTANT = /Z|[+-]\d{2}:\d{2}$/;

export function parseUnambiguousUtcMs(createdAt: string): number | null {
  if (!UNAMBIGUOUS_UTC_INSTANT.test(createdAt)) return null;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}
