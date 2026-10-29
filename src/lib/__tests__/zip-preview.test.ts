import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { openZip, isZipArchive, ZipEncryptedError, MAX_ZIP_ENTRIES } from '../zip-preview';

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// Set the "encrypted" bit in every local and central header, as a
// password-protected archive has it.
function markEncrypted(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) view.setUint16(i + 6, view.getUint16(i + 6, true) | 1, true);
    if (sig === 0x02014b50) view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true);
  }
  return out;
}

describe('openZip', () => {
  it('lists the files by folder and name, without folders or OS metadata', async () => {
    const archive = await openZip(await makeZip({
      'b.txt': 'b',
      'docs/z.md': '# z',
      'a.txt': 'a',
      'docs/inner/c.csv': '1,2',
      '__MACOSX/docs/._z.md': 'junk',
      '.DS_Store': 'junk',
      'docs/Thumbs.db': 'junk',
    }));
    expect(archive.entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'docs/z.md', 'docs/inner/c.csv']);
    expect(archive.entries[2]).toMatchObject({ name: 'z.md', folder: 'docs', size: 3 });
    expect(archive.truncated).toBe(false);
  });

  it('reads an entry from the loaded archive', async () => {
    const archive = await openZip(await makeZip({ 'docs/notes.txt': 'Grüße' }));
    expect(new TextDecoder().decode(await archive.read('docs/notes.txt'))).toBe('Grüße');
    await expect(archive.read('missing.txt')).rejects.toThrow(/not in the archive/);
  });

  it('stops listing at the cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 5; i++) files[`f${i}.txt`] = '';
    const archive = await openZip(await makeZip(files));
    expect(archive.entries).toHaveLength(MAX_ZIP_ENTRIES);
    expect(archive.truncated).toBe(true);
  });

  it('says when an archive is password-protected', async () => {
    const locked = markEncrypted(await makeZip({ 'secret.txt': 'x' }));
    await expect(openZip(locked)).rejects.toBeInstanceOf(ZipEncryptedError);
  });

  it('rejects data that is not a ZIP', async () => {
    await expect(openZip(new TextEncoder().encode('not a zip'))).rejects.not.toBeInstanceOf(ZipEncryptedError);
  });
});

describe('isZipArchive', () => {
  it('takes ZIPs by type or name, not the formats built on ZIP', () => {
    expect(isZipArchive('a.zip', 'application/zip')).toBe(true);
    expect(isZipArchive('bundle', 'application/x-zip-compressed')).toBe(true);
    expect(isZipArchive('Archive.ZIP', 'application/octet-stream')).toBe(true);
    expect(isZipArchive('contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isZipArchive('app.apk', 'application/vnd.android.package-archive')).toBe(false);
  });
});
