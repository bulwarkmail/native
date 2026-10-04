// Ported from the webmail's lib/jmap/filenode-name.ts (#869).
//
// Percent-decode a FileNode name that Stalwart stored in URI form.
//
// When a file or folder is created over WebDAV (rclone, WinSCP, Finder, ...),
// Stalwart keeps the raw, percent-encoded path segment as the FileNode name -
// "Spares Catalog" arrives as "Spares%20Catalog" and Arabic/other non-ASCII
// names as UTF-8 escapes. WebDAV clients never notice because Stalwart echoes
// that string back verbatim in <D:href> and they decode it, but JMAP
// FileNode/get returns it as-is, so the Files tab showed "Spares%20Catalog".
// Decode it at the API boundary so the UI shows the human-readable name.
//
// Conservative on purpose: a name is only decoded when it contains at least
// one valid %XX escape and decodes cleanly; a literal "%" in a JMAP-created
// name ("100% done.txt") is left untouched. A decoded "/" would turn a name
// into a path, so such names are also left alone.
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

export function decodeFileNodeName(name: string): string {
  if (!PERCENT_ESCAPE.test(name)) return name;
  try {
    const decoded = decodeURIComponent(name);
    if (decoded.includes('/') || decoded.includes('\0')) return name;
    return decoded;
  } catch {
    return name;
  }
}

// Append " (1)", " (2)", ... before the extension until the name is free in
// the target folder (webmail file-store getUniqueName). Used when uploading a
// file whose name already exists so two nodes never share one name.
export function getUniqueName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.substring(dotIndex) : '';
  let counter = 1;
  while (existingNames.has(`${base} (${counter})${ext}`)) counter++;
  return `${base} (${counter})${ext}`;
}

// "report.pdf", 2 -> "report (2).pdf": the name Stalwart's onExists "rename"
// gives a copy, used to retry on servers that ignore it (webmail numberedFileName).
export function numberedFileName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}
