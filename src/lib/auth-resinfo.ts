// Its own module so that authserv.ts (which reads the authserv-id) and
// email-headers.ts (which reads the results, and pins them through
// authserv.ts) need not import each other.

/**
 * Split one Authentication-Results header into its `;`-separated parts
 * (RFC 8601), dropping comments. A `;` inside a quoted string or a comment
 * does not split: both can carry sender-chosen text such as the envelope
 * address. Parts are trimmed but kept when empty, so the first is always
 * the authserv-id's.
 */
export function splitAuthResinfo(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) current += c + (header[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (c === ')' && --depth === 0) current += ' ';
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}
