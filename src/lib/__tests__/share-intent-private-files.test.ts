// A share intent from another app never makes the composer attach the app's
// own private files.
//
// The ways to name the same file: each of the app's providers, an authority
// with a user id in front (Android reads `0@authority` as the same provider),
// other schemes. Another app's provider with a similar name is still
// accepted: the rule is "the app's own package names", not "anything called
// FileProvider". Both package names are refused in both builds.
//
// This pins the rule in JS, at the last point before the composer uploads the
// file. The same rule holds where the intent arrives
// (ShareIntentStore.captureFromIntent), with the same cases in
// android/app/src/test/.../ShareIntentStoreTest.kt.
import { describe, it, expect } from 'vitest';
import { isForeignContentUri, shareAttachments } from '../share-intent';
import { shareToDeepLink } from '../../navigation/linking';
import { copyPreviewFile, isComposeAttachmentUri } from '../email-export';

const PKG = 'com.anonymous.bulwarkmobile';
const PLAY_PKG = 'org.bulwarkmail.mobile';

function shared(uris: string[]) {
  return shareAttachments({
    uris,
    mimeTypes: uris.map(() => 'application/octet-stream'),
    names: uris.map((_, i) => `file-${i}.bin`),
    sizes: uris.map(() => 1000),
  });
}

describe('files shared into the app', () => {
  it('drops file: URIs, which reach the app-private data directory', () => {
    expect(shared([
      `file:///data/user/0/${PKG}/databases/RKStorage`,
      `file:///data/data/${PKG}/shared_prefs/SecureStore.xml`,
      `file:///data/user/0/${PKG}/files/offline-attachments/a/invoice.pdf`,
      `FILE:///data/user/0/${PKG}/databases/RKStorage`,
      `file:/data/user/0/${PKG}/databases/RKStorage`,
      `file://localhost/data/user/0/${PKG}/databases/RKStorage`,
      'file:///sdcard/Download/report.pdf',
    ])).toEqual([]);
  });

  it("drops content: URIs of the app's own file providers, in both flavours and every spelling", () => {
    const own: string[] = [];
    for (const pkg of [PKG, PLAY_PKG]) {
      for (const provider of ['FileSystemFileProvider', 'SharingFileProvider', 'ImagePickerFileProvider', 'ClipboardFileProvider']) {
        own.push(`content://${pkg}.${provider}/expo_files/offline-attachments/a/invoice.pdf`);
      }
      own.push(`CONTENT://${pkg}.FileSystemFileProvider/expo_files/x`);
      own.push(`content://${pkg.toUpperCase()}.FileSystemFileProvider/expo_files/x`);
      // Android takes a user id in front of the authority for the same provider.
      own.push(`content://0@${pkg}.FileSystemFileProvider/expo_files/x`);
      own.push(`content://10@${pkg}.SharingFileProvider/cached_expo_files/x.eml`);
      // Any provider of the app's own package, also one added later.
      own.push(`content://${pkg}.SomeNewProvider/x`);
      own.push(`content://${pkg}/x`);
      // Android decodes the authority before it looks the provider up.
      own.push(`content://${pkg.replace(/\./g, '%2E')}.FileSystemFileProvider/expo_files/x`);
      own.push(`content://${pkg}.FileSystemFileProvider:80/expo_files/x`);
    }
    expect(shared(own)).toEqual([]);
  });

  it('drops every scheme that is not content:', () => {
    expect(shared([
      `android.resource://${PKG}/raw/secret`,
      'http://example.org/a.pdf',
      'https://example.org/a.pdf',
      'data:text/plain;base64,QQ==',
      'javascript:alert(1)',
      '/data/user/0/com.anonymous.bulwarkmobile/databases/RKStorage',
      '',
      `content:${PKG}.FileSystemFileProvider/x`,
      'content:///x',
      'content://%zz/x',
    ])).toEqual([]);
  });

  it('keeps what another app really shares', () => {
    const list = shareAttachments({
      uris: [
        'content://media/external/images/media/1000000027',
        `file:///data/user/0/${PKG}/databases/RKStorage`,
        'content://com.android.providers.downloads.documents/document/42',
        // Another app that happens to be built with the same libraries.
        'content://com.other.app.FileSystemFileProvider/expo_files/shared.pdf',
        'content://0@com.google.android.apps.photos.contentprovider/1/2/x',
      ],
      mimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'application/pdf', 'image/jpeg'],
      names: ['Screenshot.png', 'RKStorage.jpg', 'report.pdf', 'shared.pdf', 'photo.jpg'],
      sizes: [48213, 32768, 9000, 7000, 6000],
    });
    // Names, types and sizes stay lined up with the URIs that were kept.
    expect(list).toEqual([
      { uri: 'content://media/external/images/media/1000000027', name: 'Screenshot.png', type: 'image/png', size: 48213 },
      { uri: 'content://com.android.providers.downloads.documents/document/42', name: 'report.pdf', type: 'application/pdf', size: 9000 },
      { uri: 'content://com.other.app.FileSystemFileProvider/expo_files/shared.pdf', name: 'shared.pdf', type: 'application/pdf', size: 7000 },
      { uri: 'content://0@com.google.android.apps.photos.contentprovider/1/2/x', name: 'photo.jpg', type: 'image/jpeg', size: 6000 },
    ]);
    // A package whose name only starts like the app's is another app.
    expect(isForeignContentUri('content://com.anonymous.bulwarkmobilex.files/x')).toBe(true);
  });

  it('keeps the foreign file of a multiple share and drops the own one', () => {
    const list = shareAttachments({
      uris: [`content://${PKG}.FileSystemFileProvider/expo_files/offline-attachments/a/x.pdf`, 'content://media/external/file/7'],
      mimeTypes: ['application/pdf', 'image/jpeg'],
      names: ['x.pdf', 'holiday.jpg'],
      sizes: [100, 200],
    });
    expect(list).toEqual([{ uri: 'content://media/external/file/7', name: 'holiday.jpg', type: 'image/jpeg', size: 200 }]);
  });

  it('never takes shared text as a file, and keeps the recipients of a shared mailto: link', () => {
    const asText = shareToDeepLink({ text: `file:///data/user/0/${PKG}/databases/RKStorage` });
    expect(asText).toMatchObject({ kind: 'compose', to: [] });
    expect(JSON.stringify(asText)).not.toContain('prefillAttachments');
    const share = {
      text: 'mailto:someone@example.org?subject=Diagnostics',
      uris: [`file:///data/user/0/${PKG}/databases/RKStorage`],
    };
    expect(shareToDeepLink(share)).toMatchObject({ kind: 'compose', subject: 'Diagnostics' });
    expect(shareAttachments(share)).toEqual([]);
  });
});

describe('the preview of a compose attachment', () => {
  const CACHE = `file:///data/user/0/${PKG}/cache/`;

  it('copies a picker\'s copy and another app\'s file', () => {
    expect(isComposeAttachmentUri(`${CACHE}ImagePicker/2f1c.jpeg`, CACHE)).toBe(true);
    expect(isComposeAttachmentUri(`${CACHE}DocumentPicker/9a/report%20Q3.pdf`, CACHE)).toBe(true);
    expect(isComposeAttachmentUri('content://com.android.providers.downloads.documents/document/42', CACHE)).toBe(true);
    // iOS: the caches folder, also when spelled with /private in front.
    const iosCache = 'file:///var/mobile/Containers/Data/Application/AB12/Library/Caches/';
    expect(isComposeAttachmentUri('file:///private/var/mobile/Containers/Data/Application/AB12/Library/Caches/ImagePicker/x.jpg', iosCache)).toBe(true);
  });

  it('refuses any other file of the app', () => {
    for (const uri of [
      `file:///data/user/0/${PKG}/databases/RKStorage`,
      `file:///data/user/0/${PKG}/files/offline-attachments/a/invoice.pdf`,
      `${CACHE}bulwark-exports/x.pdf`,
      `${CACHE}ImagePicker/../../databases/RKStorage`,
      `${CACHE}ImagePicker/%2e%2e/%2e%2e/databases/RKStorage`,
      `${CACHE}ImagePickerX/x.jpg`,
      `content://${PKG}.FileSystemFileProvider/expo_files/offline-attachments/a/x.pdf`,
      `/data/user/0/${PKG}/databases/RKStorage`,
    ]) {
      expect(isComposeAttachmentUri(uri, CACHE), uri).toBe(false);
    }
  });

  it('throws before copying anything for a refused file', () => {
    expect(() => copyPreviewFile(`file:///data/user/0/${PKG}/databases/RKStorage`, 'RKStorage', 'application/octet-stream'))
      .toThrow('Could not open attachment');
  });
});
