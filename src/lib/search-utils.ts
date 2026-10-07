import type { EmailFilters } from '../stores/email-store';

/** The KB size field as a positive byte count, or null when unset/invalid. */
export function sizeFilterBytes(value: string | undefined): number | null {
  const kb = Number(value);
  if (!value || !Number.isFinite(kb) || kb <= 0) return null;
  return Math.round(kb * 1024);
}

/**
 * The Email/query filter for a search and its filters: the email store's
 * list search, and global search's mail (with its operators mapped onto the
 * same fields). Undefined when nothing narrows the query.
 */
export function buildJmapFilter(
  searchQuery: string,
  filters: EmailFilters,
): Record<string, unknown> | undefined {
  const conditions: Record<string, unknown>[] = [];

  const trimmed = searchQuery.trim();
  // Sent as typed: JMAP's text filter has no wildcard syntax, and Stalwart
  // drops a trailing "*" (so "runn*" finds nothing).
  if (trimmed) conditions.push({ text: trimmed });

  if (filters.keyword) conditions.push({ hasKeyword: filters.keyword });
  if (filters.from) conditions.push({ from: filters.from });
  if (filters.to) conditions.push({ to: filters.to });
  if (filters.subject) conditions.push({ subject: filters.subject });
  if (filters.body) conditions.push({ body: filters.body });

  if (filters.dateAfter) {
    const d = new Date(filters.dateAfter);
    if (!isNaN(d.getTime())) conditions.push({ after: d.toISOString() });
  }
  if (filters.dateBefore) {
    const d = new Date(filters.dateBefore);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      conditions.push({ before: d.toISOString() });
    }
  }

  if (filters.hasAttachment === true) conditions.push({ hasAttachment: true });
  else if (filters.hasAttachment === false) conditions.push({ hasAttachment: false });

  if (filters.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (filters.isUnread === false) conditions.push({ hasKeyword: '$seen' });

  if (filters.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (filters.isStarred === false) conditions.push({ notKeyword: '$flagged' });

  const minSize = sizeFilterBytes(filters.minSizeKb);
  if (minSize !== null) conditions.push({ minSize });
  const maxSize = sizeFilterBytes(filters.maxSizeKb);
  if (maxSize !== null) conditions.push({ maxSize });

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}
