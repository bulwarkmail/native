import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const session = {
  primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'f' } as Record<string, string>,
  accounts: {},
  capabilities: { 'urn:ietf:params:jmap:core': { maxConcurrentRequests: 4 } } as Record<string, unknown>,
  downloadUrl: 'http://stw/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
};
let connected = true;

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    get currentSession() { return connected ? session : null; },
    get authHeader() { return 'Basic dXNlcmM6c2VjcmV0'; },
  },
}));

import {
  ContactPhotoLoad,
  PhotoDownloadGate,
  contactPhotoSource,
  photoDownloadLimit,
  resetContactPhotoLoads,
  type ContactPhotoState,
} from '../contact-photo-loader';

beforeEach(() => {
  resetContactPhotoLoads();
  connected = true;
  session.capabilities = { 'urn:ietf:params:jmap:core': { maxConcurrentRequests: 4 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('contactPhotoSource', () => {
  it('downloads a Stalwart 1.0 photo with the Authorization header, from the contacts account', () => {
    expect(contactPhotoSource({ blobId: 'iavlkor1', mediaType: 'image/jpeg' })).toEqual({
      uri: 'http://stw/jmap/download/f/iavlkor1/photo?accept=image%2Fjpeg',
      headers: { Authorization: 'Basic dXNlcmM6c2VjcmV0' },
    });
  });

  it('downloads the photo of a shared card from the owner account', () => {
    expect(contactPhotoSource({ blobId: 'b', accountId: 'team' })?.uri)
      .toBe('http://stw/jmap/download/team/b/photo?accept=application%2Foctet-stream');
  });

  it('has nothing to show without a session', () => {
    connected = false;
    expect(contactPhotoSource({ blobId: 'b' })).toBeNull();
  });
});

describe('photoDownloadLimit', () => {
  it('leaves half of maxConcurrentRequests to JMAP calls', () => {
    expect(photoDownloadLimit()).toBe(2);
    session.capabilities = { 'urn:ietf:params:jmap:core': { maxConcurrentRequests: 1 } };
    expect(photoDownloadLimit()).toBe(1);
    session.capabilities = { 'urn:ietf:params:jmap:core': { maxConcurrentRequests: 10 } };
    expect(photoDownloadLimit()).toBe(5);
    session.capabilities = {};
    expect(photoDownloadLimit()).toBe(2);
  });
});

describe('PhotoDownloadGate', () => {
  it('runs at most `limit` at once and starts the next when one is done', () => {
    const gate = new PhotoDownloadGate(() => 2);
    const started: string[] = [];
    const releaseA = gate.acquire(() => started.push('a'));
    gate.acquire(() => started.push('b'));
    const releaseC = gate.acquire(() => started.push('c'));
    gate.acquire(() => started.push('d'));
    expect(started).toEqual(['a', 'b']);

    // A request that left the screen while waiting never starts.
    releaseC();
    releaseA();
    expect(started).toEqual(['a', 'b', 'd']);
    // Releasing twice gives nothing back twice.
    releaseA();
    gate.acquire(() => started.push('e'));
    expect(started).toEqual(['a', 'b', 'd']);
  });
});

describe('ContactPhotoLoad', () => {
  /** A started load and every state it went through, the one `start` returned first. */
  function track(key: string, gate: PhotoDownloadGate): { load: ContactPhotoLoad; states: ContactPhotoState[] } {
    const changes: ContactPhotoState[] = [];
    const load = new ContactPhotoLoad(key, (s) => changes.push(s), gate);
    const first = load.start();
    // A free slot shows the photo while start() runs; start() returns that state too.
    const states = changes.length > 0 ? changes : [first];
    return { load, states };
  }

  it('waits for a slot, and a photo that loaded once skips the queue', () => {
    const gate = new PhotoDownloadGate(() => 1);
    const statesB: ContactPhotoState[] = [];
    const a = new ContactPhotoLoad('url-a', () => undefined, gate);
    const b = new ContactPhotoLoad('url-b', (s) => statesB.push(s), gate);
    expect(a.start()).toBe('show');
    expect(b.start()).toBe('waiting');

    a.loaded();
    expect(statesB).toEqual(['show']);

    // Scrolled back: served from the image cache, no slot needed.
    const again = new ContactPhotoLoad('url-a', () => undefined, new PhotoDownloadGate(() => 0));
    expect(again.start()).toBe('show');
  });

  it('tries a failed download once more a second later, then gives up for two minutes', () => {
    vi.useFakeTimers();
    const gate = new PhotoDownloadGate(() => 2);
    const { load, states } = track('url-x', gate);
    expect(states).toEqual(['show']);

    // Refused over the concurrency limit, say.
    load.failed();
    expect(states).toEqual(['show', 'waiting']);
    vi.advanceTimersByTime(1000);
    expect(states).toEqual(['show', 'waiting', 'show']);

    load.failed();
    expect(states).toEqual(['show', 'waiting', 'show', 'failed']);

    // Another avatar of the same photo doesn't ask again for a while.
    expect(new ContactPhotoLoad('url-x', () => undefined, gate).start()).toBe('failed');
    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(new ContactPhotoLoad('url-x', () => undefined, gate).start()).toBe('show');
  });

  it('gives its slot back when it leaves the screen, also during the retry pause', () => {
    vi.useFakeTimers();
    const gate = new PhotoDownloadGate(() => 1);
    const a = new ContactPhotoLoad('url-a', () => undefined, gate);
    const statesB: ContactPhotoState[] = [];
    const b = new ContactPhotoLoad('url-b', (s) => statesB.push(s), gate);
    a.start();
    b.start();
    a.failed();
    // a's slot went to b while a waits to retry.
    expect(statesB).toEqual(['show']);
    a.dispose();
    vi.advanceTimersByTime(1000);
    b.dispose();
    const c = new ContactPhotoLoad('url-c', () => undefined, gate);
    expect(c.start()).toBe('show');
  });
});
