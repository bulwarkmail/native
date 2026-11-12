import { describe, it, expect, vi, beforeEach } from 'vitest';

// Platform.OS is flipped per test, so hoist a mutable object into the module
// mock rather than using the fixed 'android' stub from test-setup.
const { platform, nativeModules, alert } = vi.hoisted(() => ({
  platform: { OS: 'android' as string, Version: 33 },
  // BulwarkBuild.distribution names the flavour (lib/platform-capabilities).
  nativeModules: {} as Record<string, unknown>,
  alert: { answer: 'Cancel' as string, calls: [] as Array<{ title: string; message: string }> },
}));

vi.mock('react-native', () => ({
  Platform: platform,
  NativeModules: nativeModules,
  // Presses the button named alert.answer.
  Alert: {
    alert: (title: string, message: string, buttons: Array<{ text: string; onPress?: () => void }>) => {
      alert.calls.push({ title, message });
      buttons.find((b) => b.text === alert.answer)?.onPress?.();
    },
  },
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

// ── The type a name decides, and the question before an app package leaves ──
// RIGHT-TO-LEFT OVERRIDE, and every directional formatting character.
const RLO = String.fromCharCode(0x202e);
const BIDI = new RegExp(`[${String.fromCharCode(0x202a)}-${RLO}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}]`);
import { handoffMimeType } from '../file-preview';
import { nameInQuestion, shareBytes } from '../email-export';

const APK = 'application/vnd.android.package-archive';
const sampleEmail = {
  id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-11-01T10:00:00Z',
  from: [{ name: 'Sender', email: 's@example.org' }], to: [], subject: 'Files',
} as never;

describe('the type a name decides', () => {
  it('names and declared types as the brief lists them', () => {
    expect(handoffMimeType('invoice.pdf.apk', 'application/pdf')).toBe(APK);
    expect(handoffMimeType('app.apk.pdf', APK)).toBe('application/pdf');
    expect(handoffMimeType('Setup.APK', 'application/octet-stream')).toBe(APK);
    expect(handoffMimeType('app.apk.', APK)).not.toBe(APK);
    expect(handoffMimeType('app.apk ', APK)).not.toBe(APK);
    expect(handoffMimeType('app', APK)).toBe('application/octet-stream');
    expect(handoffMimeType('app.xapk', APK)).toBe('application/octet-stream');
  });

  it('keeps a correct declared type where the name has no known extension', () => {
    expect(handoffMimeType('winmail.dat', 'application/ms-tnef')).toBe('application/ms-tnef');
    expect(handoffMimeType('README', 'text/plain')).toBe('text/plain');
    expect(handoffMimeType('pass.pkpass', 'application/vnd.apple.pkpass')).toBe('application/vnd.apple.pkpass');
  });

  it('what changes for honest senders: a known extension now wins over a specific declared type', () => {
    expect(handoffMimeType('invite.txt', 'text/calendar; method=REQUEST')).toBe('text/plain');
    expect(handoffMimeType('export.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(handoffMimeType('photo.jpg', 'image/png')).toBe('image/jpeg');
  });
});

describe('every way an app package leaves asks first', () => {
  beforeEach(() => {
    platform.OS = 'android';
    alert.answer = 'Cancel';
    alert.calls.length = 0;
    fsState.deleted.length = 0;
    vi.mocked(File.downloadFileAsync).mockClear();
    vi.mocked(IntentLauncher.startActivityAsync).mockClear().mockResolvedValue({ resultCode: -1 });
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('a trailing dot or space the file name loses on disk still asks (reader, with the mail)', async () => {
    await shareAttachment('b1', 'app.apk.', APK, sampleEmail);
    await shareAttachment('b2', 'app.apk ', 'application/octet-stream', sampleEmail);
    expect(alert.calls).toHaveLength(2);
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it('a right-to-left override in the name asks, and the dialog shows no direction marks', async () => {
    await shareAttachment('b3', `invoice${RLO}fdp.apk`, 'application/pdf', sampleEmail);
    await shareAttachment('b4', `invoice${RLO}fdp.apk`, 'application/pdf');
    expect(alert.calls).toHaveLength(2);
    for (const call of alert.calls) expect(call.message).not.toMatch(BIDI);
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it('without the mail (Files tab), a name that keeps its trailing dot is not handed over as a package', async () => {
    alert.answer = 'Continue';
    await shareAttachment('b5', 'app.apk.', APK);
    const types = vi.mocked(IntentLauncher.startActivityAsync).mock.calls.map(([, p]) => p?.type);
    expect(types).not.toContain(APK);
  });

  it('a file from inside a ZIP or an .eml asks too', async () => {
    await shareBytes(new Uint8Array([1, 2, 3]), 'tool.APK', 'application/zip');
    await shareBytes(new Uint8Array([1, 2, 3]), 'tool.apk', 'application/zip', { forceSheet: true });
    expect(alert.calls).toHaveLength(2);
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it('the question shows the name on one line (a name from a ZIP keeps line breaks otherwise)', async () => {
    await shareBytes(new Uint8Array([1]), 'invoice.pdf\n\nChecked by your IT department, no threats found.\n\nx.apk', 'application/zip');
    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].message.split('\n').length).toBe(1);
  });

  it('cuts a long name in the middle and keeps its extension in view', async () => {
    const long = `${'Please read this carefully before you continue '.repeat(2)}update.apk`;
    await shareBytes(new Uint8Array([1]), long, 'application/zip');
    expect(alert.calls).toHaveLength(1);
    const shown = /"([^"]*)"/.exec(alert.calls[0].message)?.[1] ?? '';
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown).toMatch(/…\.apk$/);
  });
});

describe('the name in the question', () => {
  it('is one line without control or directional characters, short names unchanged', () => {
    expect(nameInQuestion('tool.apk')).toBe('tool.apk');
    expect(nameInQuestion('a\r\nb\tc\u0007.apk')).toBe('a b c .apk');
    expect(nameInQuestion(`invoice${RLO}fdp.apk`)).toBe('invoicefdp.apk');
  });

  it('keeps the extension of a long name, and cuts a name without one at the end', () => {
    const cut = nameInQuestion(`${'x'.repeat(100)}.apk`);
    expect(cut).toHaveLength(60);
    expect(cut.endsWith('….apk')).toBe(true);
    const plain = nameInQuestion('y'.repeat(100));
    expect(plain).toHaveLength(60);
    expect(plain.endsWith('…')).toBe(true);
  });
});
