// ZIP archives in the file preview: the entries as a list, and one entry's
// bytes when it is opened. Nothing is extracted to disk under the archive's
// paths; an opened entry goes through the same preview as any attachment.

import type JSZip from 'jszip';

export interface ZipEntry {
  /** Full path inside the archive, as stored. */
  path: string;
  /** Last path segment. */
  name: string;
  /** Folder path, '' at the top. */
  folder: string;
  /** Uncompressed size, when the archive records it. */
  size?: number;
  modified?: Date;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** True when the listing stopped at {@link MAX_ZIP_ENTRIES}. */
  truncated: boolean;
  /** One entry's bytes. */
  read(path: string): Promise<Uint8Array>;
}

/** The archive is password-protected; JSZip can't decrypt it. */
export class ZipEncryptedError extends Error {}

// Metadata the archives of macOS and Windows carry and nobody wants to open.
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

/** Most entries listed; a larger archive lists the first ones. */
export const MAX_ZIP_ENTRIES = 2000;

// JSZip keeps the directory's sizes here without exposing them.
interface ZipObjectInternals {
  _data?: { uncompressedSize?: number };
}

/**
 * Read an archive's directory: its files (not folders), sorted by folder and
 * then name, and a reader for their contents.
 */
export async function openZip(bytes: Uint8Array): Promise<ZipArchive> {
  const { default: Zip } = await import('jszip');
  let zip: JSZip;
  try {
    zip = await Zip.loadAsync(bytes, { createFolders: false });
  } catch (e) {
    if (/encrypt/i.test(e instanceof Error ? e.message : String(e))) throw new ZipEncryptedError('encrypted');
    throw e;
  }
  const entries: ZipEntry[] = [];
  let truncated = false;
  for (const file of Object.values(zip.files)) {
    if (file.dir || JUNK.test(file.name)) continue;
    if (entries.length >= MAX_ZIP_ENTRIES) {
      truncated = true;
      break;
    }
    const path = file.name;
    const slash = path.lastIndexOf('/');
    const size = (file as unknown as ZipObjectInternals)._data?.uncompressedSize;
    entries.push({
      path,
      name: slash >= 0 ? path.slice(slash + 1) : path,
      folder: slash >= 0 ? path.slice(0, slash) : '',
      size: typeof size === 'number' && size >= 0 ? size : undefined,
      modified: file.date instanceof Date && !Number.isNaN(file.date.getTime()) ? file.date : undefined,
    });
  }
  entries.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  return {
    entries,
    truncated,
    read: async (path) => {
      const file = zip.file(path);
      if (!file) throw new Error(`${path} is not in the archive`);
      return file.async('uint8array');
    },
  };
}

/** Whether a file is a ZIP the preview lists (not one of the formats built on ZIP). */
export function isZipArchive(name: string, type?: string | null): boolean {
  const mime = (type || '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime === 'application/x-zip') return true;
  return /\.zip$/i.test(name);
}
