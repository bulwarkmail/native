import { describe, it, expect, vi, beforeEach } from 'vitest';

// Platform.OS is flipped per test, so hoist a mutable object into the module
// mock rather than using the fixed 'android' stub from test-setup.
const { platform } = vi.hoisted(() => ({ platform: { OS: 'android' as string, Version: 33 } }));

vi.mock('react-native', () => ({
  Platform: platform,
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
}));

// What the mocked file system was asked to do: deleted and copied paths, and
// directory listings (by directory uri) for the stale-file sweep.
const { fsState } = vi.hoisted(() => ({
  fsState: {
    deleted: [] as string[],
    copies: [] as Array<[string, string]>,
    listings: new Map<string, Array<{ uri: string }>>(),
  },
}));

// A `File` that records both URL forms, so tests can assert which one each
// handoff path was given: expo-sharing needs `file://`, an Intent needs
// `content://`.
vi.mock('expo-file-system', () => {
  class File {
    name: string;
    uri: string;
    contentUri: string;
    exists = true;
    modificationTime: number | null = null;
    private parent: { uri: string };
    constructor(dir: { uri: string }, name: string) {
      this.parent = dir;
      this.name = name;
      this.uri = `${dir.uri}${name}`;
      this.contentUri = `content://org.bulwarkmail.mobile.FileSystemFileProvider/${name}`;
    }
    get parentDirectory() { return this.parent; }
    create() {}
    delete() { fsState.deleted.push(this.uri); }
    write() {}
    copy(dest: { uri: string }) { fsState.copies.push([this.uri, dest.uri]); }
    static downloadFileAsync = vi.fn(async () => undefined);
  }
  class Directory {
    uri: string;
    name: string;
    exists = true;
    constructor(parent: { uri: string }, name: string) {
      this.name = name;
      this.uri = `${parent.uri}${name}/`;
    }
    create() {}
    delete() { fsState.deleted.push(this.uri); }
    list() {
      return (fsState.listings.get(this.uri) ?? []).filter((e) => !fsState.deleted.includes(e.uri));
    }
  }
  return {
    File,
    Directory,
    Paths: {
      cache: { uri: 'file:///cache/', list: () => fsState.listings.get('file:///cache/') ?? [] },
      document: { uri: 'file:///documents/' },
    },
  };
});

vi.mock('expo-intent-launcher', () => ({
  startActivityAsync: vi.fn(async () => ({ resultCode: -1 })),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock('../client-cert', () => ({
  getClientCertAlias: vi.fn(async () => null),
  secureFetch: vi.fn(),
}));

const { jmapClientMock } = vi.hoisted(() => ({
  jmapClientMock: {
    authHeader: 'Bearer token',
    ensureFreshToken: vi.fn(async () => undefined),
    forceRefreshToken: vi.fn(async () => false),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: jmapClientMock,
}));

vi.mock('../../api/blob', () => ({
  getDownloadUrl: vi.fn((blobId: string, name: string) => `https://mail.example.com/${blobId}/${name}`),
  isStaleUploadCopy: (name: string) => name.startsWith('upload-old-'),
}));

import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { File, Directory } from 'expo-file-system';
import { getDownloadUrl } from '../../api/blob';
import {
  shareAttachment, downloadAttachment, cachePreviewFile, discardPreviewFile, saveLocalFileCopy,
  shareLocalFile, writePreviewFile,
} from '../email-export';

const VIEW = 'android.intent.action.VIEW';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

describe('shareAttachment (preview)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.mocked(IntentLauncher.startActivityAsync).mockClear().mockResolvedValue({ resultCode: -1 });
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('hands the file to a viewer app via a VIEW intent on Android', async () => {
    await shareAttachment('blob-1', 'report.pdf', 'application/pdf');

    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith(VIEW, {
      data: 'content://org.bulwarkmail.mobile.FileSystemFileProvider/report.pdf',
      type: 'application/pdf',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    // The share sheet is what the direct handoff exists to avoid.
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('falls back to the share sheet when no app handles the type', async () => {
    vi.mocked(IntentLauncher.startActivityAsync).mockRejectedValue(
      new Error('No Activity found to handle Intent'),
    );

    await shareAttachment('blob-2', 'weird.xyz', 'application/x-weird');

    // file:// — expo-sharing rejects content:// URLs outright.
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/bulwark-exports/weird.xyz', {
      mimeType: 'application/x-weird',
      dialogTitle: 'weird.xyz',
    });
  });

  it('surfaces a download failure instead of silently falling back', async () => {
    const { File } = await import('expo-file-system');
    vi.mocked(File.downloadFileAsync).mockRejectedValueOnce(new Error('Download failed: 404'));

    await expect(shareAttachment('blob-3', 'gone.pdf', 'application/pdf')).rejects.toThrow(
      'Download failed: 404',
    );
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it('refreshes the token before downloading and retries once after a 401', async () => {
    const { File } = await import('expo-file-system');
    jmapClientMock.ensureFreshToken.mockClear();
    jmapClientMock.forceRefreshToken.mockClear().mockResolvedValueOnce(true);
    vi.mocked(File.downloadFileAsync).mockClear()
      .mockRejectedValueOnce(new Error('Download failed: 401'))
      .mockResolvedValueOnce(undefined as never);

    await shareAttachment('blob-6', 'report.pdf', 'application/pdf');

    expect(jmapClientMock.ensureFreshToken).toHaveBeenCalledTimes(1);
    expect(jmapClientMock.forceRefreshToken).toHaveBeenCalledTimes(1);
    expect(File.downloadFileAsync).toHaveBeenCalledTimes(2);
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledTimes(1);
  });

  it('gives up when the 401 persists after a refresh', async () => {
    const { File } = await import('expo-file-system');
    jmapClientMock.forceRefreshToken.mockClear().mockResolvedValueOnce(false);
    vi.mocked(File.downloadFileAsync).mockRejectedValueOnce(new Error('Download failed: 401'));

    await expect(shareAttachment('blob-7', 'x.pdf', 'application/pdf')).rejects.toThrow('401');
  });

  it('uses the share sheet on iOS', async () => {
    platform.OS = 'ios';

    await shareAttachment('blob-4', 'photo.jpg', 'image/jpeg');

    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/bulwark-exports/photo.jpg', {
      mimeType: 'image/jpeg',
      dialogTitle: 'photo.jpg',
    });
  });
});

describe('downloadAttachment (save a copy)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.mocked(IntentLauncher.startActivityAsync).mockClear().mockResolvedValue({ resultCode: -1 });
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('keeps the share sheet on Android so the save dialog stays reachable', async () => {
    await downloadAttachment('blob-5', 'report.pdf', 'application/pdf');

    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///documents/report.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'report.pdf',
    });
  });
});

describe('cachePreviewFile (in-app preview)', () => {
  beforeEach(() => {
    fsState.deleted.length = 0;
    vi.mocked(File.downloadFileAsync).mockClear();
    vi.mocked(getDownloadUrl).mockClear();
  });

  it('downloads into a folder of its own, keeping the real name and the owning account', async () => {
    const file = await cachePreviewFile('blob-p', 'report.pdf', 'application/pdf', 'acct-2');

    expect(getDownloadUrl).toHaveBeenCalledWith('blob-p', 'report.pdf', 'application/pdf', 'acct-2');
    expect(file.uri).toMatch(/^file:\/\/\/cache\/bulwark-exports\/preview-[^/]+\/report\.pdf$/);
    expect(File.downloadFileAsync).toHaveBeenCalledWith(
      'https://mail.example.com/blob-p/report.pdf',
      file,
      { headers: { Authorization: 'Bearer token' }, idempotent: true },
    );
  });

  it('never reuses a path, so two files with one name do not share an image cache entry', async () => {
    const a = await cachePreviewFile('blob-a', 'photo.jpg', 'image/jpeg');
    const b = await cachePreviewFile('blob-b', 'photo.jpg', 'image/jpeg');

    expect(a.name).toBe('photo.jpg');
    expect(b.name).toBe('photo.jpg');
    expect(a.uri).not.toBe(b.uri);
  });

  it('makes the name safe for the file system', async () => {
    const file = await cachePreviewFile('blob-n', 'a:b?.txt', 'text/plain');
    expect(file.name).toBe('a_b_.txt');
  });

  it('removes its folder and rethrows when the download fails', async () => {
    vi.mocked(File.downloadFileAsync).mockRejectedValueOnce(new Error('Download failed: 404'));

    await expect(cachePreviewFile('blob-x', 'gone.txt', 'text/plain')).rejects.toThrow('404');
    expect(fsState.deleted).toHaveLength(1);
    expect(fsState.deleted[0]).toMatch(/\/bulwark-exports\/preview-[^/]+\/$/);
  });
});

describe('writePreviewFile (parts unpacked on the device)', () => {
  it('writes into a folder of its own, so two parts with one name get different paths', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const a = writePreviewFile(bytes, 'image001.png', 'image/png');
    const b = writePreviewFile(bytes, 'image001.png', 'image/png');

    expect(a.name).toBe('image001.png');
    expect(a.uri).toMatch(/^file:\/\/\/cache\/bulwark-exports\/preview-[^/]+\/image001\.png$/);
    expect(a.uri).not.toBe(b.uri);
  });

  it('is removed with its folder like a downloaded preview', () => {
    fsState.deleted.length = 0;
    const file = writePreviewFile(new Uint8Array([1]), 'notes.txt', 'text/plain');
    discardPreviewFile(file);

    expect(fsState.deleted).toEqual([file.uri.replace(/notes\.txt$/, '')]);
  });
});

describe('discardPreviewFile', () => {
  beforeEach(() => {
    fsState.deleted.length = 0;
  });

  it('deletes the preview file together with its folder', async () => {
    const file = await cachePreviewFile('blob-d', 'notes.txt', 'text/plain');
    discardPreviewFile(file);

    expect(fsState.deleted).toEqual([file.uri.replace(/notes\.txt$/, '')]);
  });

  it('only deletes the file itself outside a preview folder', () => {
    const exports = new Directory({ uri: 'file:///cache/' } as never, 'bulwark-exports');
    const file = new File(exports as never, 'shared.zip');
    discardPreviewFile(file);

    expect(fsState.deleted).toEqual(['file:///cache/bulwark-exports/shared.zip']);
  });
});

describe('saveLocalFileCopy (Download from a preview)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    fsState.copies.length = 0;
    vi.mocked(File.downloadFileAsync).mockClear();
    vi.mocked(IntentLauncher.startActivityAsync).mockClear();
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('copies the file into documents and offers the share sheet without downloading again', async () => {
    const preview = await cachePreviewFile('blob-s', 'report.pdf', 'application/pdf');
    vi.mocked(File.downloadFileAsync).mockClear();

    await saveLocalFileCopy(preview, 'application/pdf');

    expect(fsState.copies).toEqual([[preview.uri, 'file:///documents/report.pdf']]);
    expect(File.downloadFileAsync).not.toHaveBeenCalled();
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///documents/report.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'report.pdf',
    });
  });
});

describe('shareLocalFile', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    fsState.deleted.length = 0;
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('removes the file after sharing by default', async () => {
    const file = new File({ uri: 'file:///cache/bulwark-exports/' } as never, 'bundle.zip');
    await shareLocalFile(file, 'application/zip');

    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
    expect(fsState.deleted).toEqual([file.uri]);
  });

  it('keeps the file an open preview still shows', async () => {
    const file = new File({ uri: 'file:///cache/bulwark-exports/preview-1/' } as never, 'photo.jpg');
    await shareLocalFile(file, 'image/jpeg', 'photo.jpg', { forceSheet: true, keep: true });

    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
    expect(fsState.deleted).toEqual([]);
  });
});

// Last: it reloads the module to get a process that has not swept yet.
describe('sweepStaleExportFiles', () => {
  it('clears stale files, and preview folders once they are empty', async () => {
    vi.resetModules();
    const fsMod = await import('expo-file-system');
    const { sweepStaleExportFiles } = await import('../email-export');
    fsState.deleted.length = 0;
    fsState.listings.clear();

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const root = new fsMod.Directory({ uri: 'file:///cache/' } as never, 'bulwark-exports');
    const aged = (dir: { uri: string }, name: string, age: number) => {
      const f = new fsMod.File(dir as never, name);
      (f as unknown as { modificationTime: number }).modificationTime = now - age;
      return f;
    };
    const oldExport = aged(root, 'old.pdf', 2 * day);
    const newExport = aged(root, 'new.pdf', 60_000);
    const handedOff = new fsMod.Directory(root as never, 'preview-a');
    const open = new fsMod.Directory(root as never, 'preview-b');
    const other = new fsMod.Directory(root as never, 'keep-me');
    fsState.listings.set(root.uri, [oldExport, newExport, handedOff, open, other]);
    fsState.listings.set(handedOff.uri, [aged(handedOff, 'photo.jpg', 2 * day)]);
    fsState.listings.set(open.uri, [aged(open, 'notes.txt', 60_000)]);
    fsState.listings.set(other.uri, [aged(other, 'x.bin', 2 * day)]);

    await sweepStaleExportFiles();

    expect(fsState.deleted).toEqual([
      oldExport.uri,
      `${handedOff.uri}photo.jpg`,
      handedOff.uri,
    ]);
  });

  it('removes the upload copies an earlier run left in the cache', async () => {
    vi.resetModules();
    const fsMod = await import('expo-file-system');
    const { sweepStaleExportFiles } = await import('../email-export');
    fsState.deleted.length = 0;
    fsState.listings.clear();
    const cache = { uri: 'file:///cache/' };
    fsState.listings.set(cache.uri, ['upload-old-1', 'upload-current-2', 'image-cache.png']
      .map((name) => new fsMod.File(cache as never, name)));

    await sweepStaleExportFiles();

    expect(fsState.deleted).toEqual(['file:///cache/upload-old-1']);
  });
});
