import { File } from 'expo-file-system';

// Mirrors the webmail `lib/eml-import.ts`: turn picked files into a flat list of
// importable `.eml` messages, expanding `.zip` archives along the way. On RN the
// picker hands us file URIs (file:// or content://) rather than File objects, so
// we read bytes via expo-file-system and upload those.

export interface ImportableEml {
  name: string;
  bytes: Uint8Array;
}

export const EML_IMPORT_TYPES = [
  'message/rfc822',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream', // some pickers report .eml/.zip as octet-stream
];

function isEmlName(name: string): boolean {
  return /\.eml$/i.test(name);
}

function isZip(name: string, mime?: string): boolean {
  return /\.zip$/i.test(name) || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

async function extractEmlsFromZip(bytes: Uint8Array): Promise<ImportableEml[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const out: ImportableEml[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !isEmlName(entry.name)) continue;
    const data = await entry.async('uint8array');
    out.push({ name: entry.name.split(/[\\/]/).pop() || entry.name, bytes: data });
  }
  return out;
}

/**
 * Expand a single picked file (by URI) into its importable `.eml` messages.
 * A `.eml` yields one entry; a `.zip` yields one per `.eml` it contains.
 */
export async function expandImportableEml(
  uri: string,
  name: string,
  mime?: string,
): Promise<ImportableEml[]> {
  const bytes = await new File(uri).bytes();
  if (isZip(name, mime)) return extractEmlsFromZip(bytes);
  return [{ name, bytes }];
}
