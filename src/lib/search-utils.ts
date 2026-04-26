export function toWildcardQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.endsWith('*') || word.endsWith('"') ? word : word + '*'))
    .join(' ');
}
