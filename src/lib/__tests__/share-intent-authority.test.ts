// The provider of a shared address, read as Android reads it: Uri.parse ends
// the authority at a backslash as well as at '/', '?' and '#'
// (Uri.StringUri.parseAuthority), so "content://<own>\@other/..." is
// answered by <own>. The same cases as ShareIntentStoreAuthorityTest.kt.
import { describe, it, expect } from 'vitest';
import { isForeignContentUri, shareAttachments } from '../share-intent';
import { isComposeAttachmentUri } from '../email-export';

const PKG = 'com.anonymous.bulwarkmobile';
const PLAY_PKG = 'org.bulwarkmail.mobile';
const CACHE = `file:///data/user/0/${PKG}/cache/`;

describe('the authority as Android resolves it', () => {
  it('refuses an own provider followed by a backslash (Android ends the authority there)', () => {
    for (const p of [PKG, PLAY_PKG]) {
      expect(isForeignContentUri(`content://${p}.FileSystemFileProvider\\@evil.example/expo_files/x`)).toBe(false);
      expect(isForeignContentUri(`content://${p}.SharingFileProvider\\cached_expo_files@evil.example/x`)).toBe(false);
      expect(isForeignContentUri(`content://${p}.rnwidget.imageprovider\\@evil.example/x.png`)).toBe(false);
    }
  });

  it('keeps names lined up when the refused one is in the middle', () => {
    const uris = [
      'content://media/external/images/media/1',
      `content://${PKG}.FileSystemFileProvider\\@evil.example/expo_files/x`,
      'content://com.android.providers.downloads.documents/document/42',
    ];
    const out = shareAttachments({ uris, mimeTypes: ['image/jpeg', 'application/octet-stream', 'application/pdf'], names: ['a.jpg', 'RKStorage', 'b.pdf'], sizes: [1, 2, 3] });
    expect(out.map((a) => a.name)).toEqual(['a.jpg', 'b.pdf']);
  });

  it('agrees with Android where the spellings resolve the same way', () => {
    // Android takes what follows the last '@' as the provider.
    expect(isForeignContentUri(`content://${PKG}.FileSystemFileProvider@evil.example/x`)).toBe(true);
    // An encoded backslash is no delimiter for Android: the provider is what follows the '@'.
    expect(isForeignContentUri(`content://${PKG}.FileSystemFileProvider%5C@evil.example/x`)).toBe(true);
    expect(isForeignContentUri(`content://x@${PKG}.FileSystemFileProvider/expo_files/x`)).toBe(false);
    expect(isForeignContentUri(`content://evil:1@${PKG}.FileSystemFileProvider/expo_files/x`)).toBe(false);
    expect(isForeignContentUri(`content://0%40${PKG}.FileSystemFileProvider/expo_files/x`)).toBe(false);
    expect(isForeignContentUri(`content:// ${PKG}.FileSystemFileProvider/expo_files/x`)).toBe(false);
    expect(isForeignContentUri(`content://${PKG}.FileSystemFileProvider./expo_files/x`)).toBe(false);
    expect(isForeignContentUri('content://0@/x')).toBe(false);
  });
});

describe('compose attachment preview paths', () => {
  it('refuses traversal in every spelling and the picker folder itself', () => {
    for (const uri of [
      `${CACHE}ImagePicker/..%2F..%2Fdatabases%2FRKStorage`,
      `${CACHE}ImagePicker/%2F..%2F..%2Fdatabases/RKStorage`,
      `${CACHE}ImagePicker//..//..//databases/RKStorage`,
      `${CACHE}ImagePicker/./../../databases/RKStorage`,
      `${CACHE}ImagePicker/%2E%2E/%2E%2E/databases/RKStorage`,
      `${CACHE}ImagePicker/%C0%AE%C0%AE/x`,
      `${CACHE}ImagePicker`,
      `${CACHE}ImagePicker/x.jpg?x=/../../databases/RKStorage`,
      `${CACHE}ImagePicker/x.jpg#/../../databases/RKStorage`,
      `file:////data/user/0/${PKG}/cache/ImagePicker/x.jpg`,
      `FILE:///data/user/0/${PKG}/files/offline-attachments/a/x.pdf`,
      `CONTENT://${PKG}.FileSystemFileProvider/expo_files/x`,
      `content://${PKG}.FileSystemFileProvider\\@evil.example/expo_files/x`,
    ]) {
      expect(isComposeAttachmentUri(uri, CACHE), uri).toBe(false);
    }
  });

  it('still opens what the pickers hand over', () => {
    expect(isComposeAttachmentUri(`${CACHE}ImagePicker/0b0f-4c.jpeg`, CACHE)).toBe(true);
    expect(isComposeAttachmentUri(`${CACHE}DocumentPicker/1c2d/Report%20Q3%20(final).pdf`, CACHE)).toBe(true);
    expect(isComposeAttachmentUri(`${CACHE}DocumentPicker/1c2d/notes..txt`, CACHE)).toBe(true);
  });
});
