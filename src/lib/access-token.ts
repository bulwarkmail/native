// Clean what the user pasted as an access token: surrounding whitespace and a
// leading "Bearer " (copied from an Authorization header) are dropped. Empty
// text, or text with whitespace left inside, is not a token (null).
export function cleanAccessToken(typed: string): string | null {
  const token = typed.trim().replace(/^Bearer\s+/i, '');
  if (!token || /\s/.test(token)) return null;
  return token;
}
