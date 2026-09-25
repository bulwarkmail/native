// base64 data: URIs, as contact photos carry them (webmail lib/data-uri.ts).
//
// Stalwart writes three shapes: `data:<type>;base64,…`, `data:;base64,…`
// (0.16.x) and `data:base64,…` (0.16.0, no parameter separator). The last two
// carry no media type, so it comes from the card's `mediaType` when known.

/** The media type (if any) and base64 payload of a base64 data: URI. */
export function parseBase64DataUri(uri: string): { type?: string; data: string } | null {
  if (!uri.toLowerCase().startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma).split(';');
  if (header[header.length - 1].trim().toLowerCase() !== 'base64') return null;
  const type = header.length > 1 ? header[0].trim() : '';
  return { type: type || undefined, data: uri.slice(comma + 1) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * The bytes of a base64 data: URI with their media type; `fallbackType`
 * applies when the URI names none. Null for anything else.
 */
export function dataUriToBytes(
  uri: string,
  fallbackType?: string,
): { bytes: Uint8Array; type: string } | null {
  const parsed = parseBase64DataUri(uri);
  if (!parsed) return null;
  let binary: string;
  try {
    binary = atob(parsed.data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, type: parsed.type || fallbackType || 'application/octet-stream' };
}
