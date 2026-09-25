/** What Stalwart stores for content without a usable media type. */
export const OCTET_STREAM = 'application/octet-stream';

// RFC 6838 restricted-name: a letter or digit, then at most 126 more from a
// small set.
const RESTRICTED_NAME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The essence of a media type: `top/sub` in lowercase, without parameters
 * ("Text/Plain; charset=utf-8" becomes "text/plain"), or
 * application/octet-stream when there is none. Stalwart 1.0 refuses any
 * other FileNode `type` (`is_valid_media_type`, types/src/media_type/mod.rs);
 * 0.16.6+ take anything with a "/" up to 256 characters.
 */
export function mediaTypeEssence(value: string | null | undefined): string {
  const essence = (value ?? '').split(';', 1)[0].replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const slash = essence.indexOf('/');
  if (slash < 0) return OCTET_STREAM;
  const top = essence.slice(0, slash);
  const sub = essence.slice(slash + 1);
  return RESTRICTED_NAME.test(top) && RESTRICTED_NAME.test(sub) ? essence.toLowerCase() : OCTET_STREAM;
}
