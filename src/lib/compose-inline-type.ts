// The media type of a quoted original's inline image, as the composer shows
// it (a data: URI) and attaches it again on send. The server hands the part's
// Content-Type over verbatim, parameters, quotes and `>` included, so only a
// plain `image/<subtype>` is taken from it (the rule of lib/email-html's
// inline image check); otherwise the bytes decide.

const PLAIN_IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/;

/**
 * `declared` without parameters when it is a plain image type ("image/jpeg;
 * name=x" is "image/jpeg"), else `sniffed`, else image/png.
 */
export function inlineImageType(declared: string | null | undefined, sniffed: string | null | undefined): string {
  const essence = (declared ?? '').toLowerCase().split(';')[0].trim();
  if (PLAIN_IMAGE_TYPE.test(essence)) return essence;
  return sniffed ?? 'image/png';
}
