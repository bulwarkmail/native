import { describe, it, expect, vi, beforeEach } from 'vitest';

// Blob capability of userc's account as the test servers advertise it
// (live-checked): Stalwart 1.0 lists ContactCard, 0.16.23 does not.
const BLOB_1_0 = {
  maxSizeBlobSet: 7499488,
  maxDataSources: 16,
  supportedTypeNames: ['Email', 'Thread', 'SieveScript', 'CalendarEvent', 'ContactCard'],
  supportedDigestAlgorithms: ['sha', 'sha-256', 'sha-512'],
};
const BLOB_0_16 = {
  maxSizeBlobSet: 7499488,
  maxDataSources: 16,
  supportedTypeNames: ['Email', 'Thread', 'SieveScript'],
  supportedDigestAlgorithms: ['sha', 'sha-256', 'sha-512'],
};

const session = {
  primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'f' } as Record<string, string>,
  accounts: {} as Record<string, { name: string; isPersonal: boolean; accountCapabilities?: Record<string, unknown> }>,
  capabilities: {} as Record<string, unknown>,
  downloadUrl: 'http://stw/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
};

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    serverUrl: 'http://stw',
    get currentSession() { return session; },
    getAccountCapability: (urn: string, accountId?: string) => {
      const caps = session.accounts[accountId ?? 'f']?.accountCapabilities;
      if (caps && urn in caps) return caps[urn];
      return session.capabilities[urn];
    },
    hasCapability: (urn: string) => Boolean(session.capabilities[urn]),
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    fetchBlobArrayBuffer: vi.fn(),
  },
}));

vi.mock('../../api/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/blob')>()),
  uploadBytes: vi.fn(),
}));

import { jmapClient } from '../../api/jmap-client';
import { uploadBytes } from '../../api/blob';
import { JMAPMethodError, JMAPSetError } from '../../api/jmap-result';
import type { ContactCard, ContactMedia } from '../../api/types';
import {
  inlineContactMedia,
  inlineContactMediaForExport,
  isBlobMediaRejection,
  mediaForFormSave,
  mediaForPhotoEdit,
  resetContactBlobMediaRefusals,
  supportsContactBlobMedia,
  writeContactWithNewPhoto,
} from '../contact-media';
import { contactsToVCard } from '../vcard';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockFetchBlob = jmapClient.fetchBlobArrayBuffer as ReturnType<typeof vi.fn>;
const mockUpload = uploadBytes as ReturnType<typeof vi.fn>;

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const JPEG_URI = `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString('base64')}`;
const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';

function useServer(version: '1.0' | '0.16', extraAccounts: Record<string, Record<string, unknown>> = {}) {
  const blob = version === '1.0' ? BLOB_1_0 : BLOB_0_16;
  session.accounts = {
    f: { name: 'userc@example.org', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:blob': blob } },
  };
  for (const [id, caps] of Object.entries(extraAccounts)) {
    session.accounts[id] = { name: id, isPersonal: false, accountCapabilities: caps };
  }
  session.capabilities = {
    'urn:ietf:params:jmap:core': { maxConcurrentRequests: 4 },
    'urn:ietf:params:jmap:blob': {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetContactBlobMediaRefusals();
  useServer('1.0');
});

describe('mediaForPhotoEdit', () => {
  // A 1.0 card: every entry a blob, as ContactCard/get returns it.
  const card10: Record<string, ContactMedia> = {
    photo: { blobId: 'b-photo', kind: 'photo', mediaType: 'image/jpeg', pref: 1, label: 'Main', contexts: { work: true } },
    logo: { blobId: 'b-logo', kind: 'logo', mediaType: 'image/png' },
  };

  it('puts a new photo in the place of the shown one, with its pref, label and contexts (Stalwart 1.0)', () => {
    const edit = mediaForPhotoEdit(card10, card10, 'photo', { kind: 'new', uri: JPEG_URI, mediaType: 'image/jpeg' });
    expect(edit.photoKey).toBe('photo');
    expect(edit.media).toEqual({
      photo: { kind: 'photo', uri: JPEG_URI, mediaType: 'image/jpeg', pref: 1, label: 'Main', contexts: { work: true } },
      // Passed through as the server returned it: 1.0 resolves the blobId again.
      logo: { blobId: 'b-logo', kind: 'logo', mediaType: 'image/png' },
    });
  });

  it('passes the other entries of a 0.16 card through as data: URIs', () => {
    const card016: Record<string, ContactMedia> = {
      photo: { uri: JPEG_URI, kind: 'photo', mediaType: 'image/jpeg' },
      logo: { uri: PNG_URI, kind: 'logo', mediaType: 'image/png' },
    };
    const edit = mediaForPhotoEdit(card016, card016, 'photo', { kind: 'new', uri: PNG_URI, mediaType: 'image/png' });
    expect(edit.media).toEqual({
      photo: { kind: 'photo', uri: PNG_URI, mediaType: 'image/png' },
      logo: { uri: PNG_URI, kind: 'logo', mediaType: 'image/png' },
    });
  });

  it('gives a first photo a key no other entry uses', () => {
    const base: Record<string, ContactMedia> = { photo: { kind: 'logo', blobId: 'b-logo' } };
    const edit = mediaForPhotoEdit(base, base, undefined, { kind: 'new', uri: JPEG_URI, mediaType: 'image/jpeg' });
    expect(edit.photoKey).toBe('photo1');
    expect(edit.media).toEqual({ ...base, photo1: { kind: 'photo', uri: JPEG_URI, mediaType: 'image/jpeg' } });
    expect(mediaForPhotoEdit({}, {}, undefined, { kind: 'new', uri: JPEG_URI, mediaType: 'image/jpeg' }).photoKey).toBe('photo');
  });

  it('removes every photo the form knew, keeping logos, sounds and photos added since', () => {
    const known: Record<string, ContactMedia> = {
      p1: { blobId: 'b-1', kind: 'photo' },
      p2: { blobId: 'b-2', kind: 'photo', pref: 3 },
      logo: { blobId: 'b-logo', kind: 'logo' },
    };
    const base = { ...known, p3: { blobId: 'b-3', kind: 'photo' }, sound: { blobId: 'b-s', kind: 'sound' } };
    expect(mediaForPhotoEdit(base, known, 'p1', { kind: 'removed' }).media).toEqual({
      logo: { blobId: 'b-logo', kind: 'logo' },
      p3: { blobId: 'b-3', kind: 'photo' },
      sound: { blobId: 'b-s', kind: 'sound' },
    });
  });

  it('sends null when the photo was the only entry', () => {
    const only = { photo: { blobId: 'b-photo', kind: 'photo' } };
    expect(mediaForPhotoEdit(only, only, 'photo', { kind: 'removed' })).toEqual({ media: null });
  });

  it('builds on the server copy, so a logo changed elsewhere is not sent back with its old blobId (Stalwart 1.0)', () => {
    const known = { photo: { blobId: 'b-photo', kind: 'photo' }, logo: { blobId: 'b-logo-old', kind: 'logo' } };
    const current = { photo: { blobId: 'b-photo', kind: 'photo' }, logo: { blobId: 'b-logo-new', kind: 'logo' } };
    const edit = mediaForPhotoEdit(current, known, 'photo', { kind: 'new', uri: JPEG_URI, mediaType: 'image/jpeg' });
    expect(edit.media?.logo).toEqual({ blobId: 'b-logo-new', kind: 'logo' });
  });
});

describe('mediaForFormSave', () => {
  const known: Record<string, ContactMedia> = { photo: { blobId: 'b-photo', kind: 'photo', mediaType: 'image/jpeg' } };

  it('leaves media out of the save when the photo is unchanged, on 0.16 and 1.0', () => {
    expect(mediaForFormSave(known, null, { kind: 'unchanged' })).toBeNull();
    expect(mediaForFormSave({ photo: { uri: JPEG_URI, kind: 'photo' } }, null, { kind: 'unchanged' })).toBeNull();
  });

  it('builds on the form copy when the server copy could not be read', () => {
    const edit = mediaForFormSave(known, null, { kind: 'new', uri: PNG_URI, mediaType: 'image/png' });
    expect(edit).toEqual({ media: { photo: { kind: 'photo', uri: PNG_URI, mediaType: 'image/png' } }, photoKey: 'photo' });
  });

  it('replaces the server photo when the card came from the cache without media', () => {
    const current = { media: { p9: { blobId: 'b-9', kind: 'photo', pref: 1 }, logo: { blobId: 'b-l', kind: 'logo' } } };
    const edit = mediaForFormSave(undefined, current, { kind: 'new', uri: PNG_URI, mediaType: 'image/png' });
    expect(edit?.photoKey).toBe('p9');
    expect(edit?.media).toEqual({
      p9: { kind: 'photo', uri: PNG_URI, mediaType: 'image/png', pref: 1 },
      logo: { blobId: 'b-l', kind: 'logo' },
    });
  });

  it('does nothing when a photo the form never showed is removed', () => {
    const current = { media: { photo: { blobId: 'b-photo', kind: 'photo' } } };
    expect(mediaForFormSave(undefined, current, { kind: 'removed' })).toBeNull();
    expect(mediaForFormSave({}, current, { kind: 'removed' })).toBeNull();
  });

  it('removes the shown photo from the server copy', () => {
    const current = { media: { ...known, logo: { blobId: 'b-l', kind: 'logo' } } };
    expect(mediaForFormSave(known, current, { kind: 'removed' })).toEqual({ media: { logo: { blobId: 'b-l', kind: 'logo' } } });
  });
});

describe('supportsContactBlobMedia', () => {
  it('reads ContactCard from the blob capability: yes on Stalwart 1.0, no on 0.16', () => {
    expect(supportsContactBlobMedia('f')).toBe(true);
    useServer('0.16');
    expect(supportsContactBlobMedia('f')).toBe(false);
  });

  it('says no for an account without the capability, whatever the session says', () => {
    useServer('1.0', { team: {} });
    expect(supportsContactBlobMedia('team')).toBe(false);
  });
});

describe('isBlobMediaRejection', () => {
  it('matches 0.16\'s refusal of a blobId in media', () => {
    expect(isBlobMediaRejection(new JMAPSetError('invalidProperties', 'blobIds in media is not supported.', ['media']))).toBe(true);
    expect(isBlobMediaRejection(new JMAPSetError('invalidProperties', 'x', ['media/photo']))).toBe(true);
  });

  it('does not match 1.0\'s stale blobId, which names no property, or other errors', () => {
    expect(isBlobMediaRejection(new JMAPSetError(
      'invalidProperties',
      'The following blobIds do not exist or are not accessible: iavlkor1.',
    ))).toBe(false);
    expect(isBlobMediaRejection(new JMAPSetError('invalidProperties', 'x', ['name']))).toBe(false);
    expect(isBlobMediaRejection(new JMAPMethodError('forbidden'))).toBe(false);
    expect(isBlobMediaRejection(new Error('boom'))).toBe(false);
  });
});

describe('writeContactWithNewPhoto', () => {
  const newCard = (): Partial<ContactCard> => ({
    name: { full: 'Carol' },
    media: {
      photo: { kind: 'photo', uri: JPEG_URI, mediaType: 'image/jpeg', pref: 1 },
      logo: { blobId: 'b-logo', kind: 'logo', mediaType: 'image/png' },
    },
  });

  it('uploads the photo and sends its blobId on Stalwart 1.0', async () => {
    mockUpload.mockResolvedValue({ blobId: 'eavlk-up', type: 'image/jpeg', size: JPEG_BYTES.length });
    const write = vi.fn().mockResolvedValue('saved');

    await expect(writeContactWithNewPhoto(undefined, newCard(), 'photo', write)).resolves.toBe('saved');

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [bytes, type, accountId] = mockUpload.mock.calls[0];
    expect(Array.from(bytes as Uint8Array)).toEqual(JPEG_BYTES);
    expect(type).toBe('image/jpeg');
    expect(accountId).toBe('f');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].media).toEqual({
      photo: { kind: 'photo', blobId: 'eavlk-up', mediaType: 'image/jpeg', pref: 1 },
      logo: { blobId: 'b-logo', kind: 'logo', mediaType: 'image/png' },
    });
  });

  it('uploads into the user\'s own account for a card in a shared address book (Stalwart 1.0)', async () => {
    useServer('1.0', { team: { 'urn:ietf:params:jmap:blob': BLOB_1_0 } });
    mockUpload.mockResolvedValue({ blobId: 'eavlk-up', type: 'image/jpeg', size: 6 });
    const write = vi.fn().mockResolvedValue(undefined);
    await writeContactWithNewPhoto('team', newCard(), 'photo', write);
    expect(mockUpload.mock.calls[0][2]).toBe('f');
    expect(write.mock.calls[0][0].media.photo.blobId).toBe('eavlk-up');
  });

  it('sends the data: URI and uploads nothing on 0.16', async () => {
    useServer('0.16');
    const write = vi.fn().mockResolvedValue(undefined);
    const card = newCard();
    await writeContactWithNewPhoto(undefined, card, 'photo', write);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(card);
  });

  it('falls back to the data: URI once when the server refuses the blobId the way 0.16 does, and remembers it', async () => {
    mockUpload.mockResolvedValue({ blobId: 'eavlk-up', type: 'image/jpeg', size: 6 });
    const refusal = new JMAPSetError('invalidProperties', 'blobIds in media is not supported. (media)', ['media']);
    const write = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue('saved');
    const card = newCard();

    await expect(writeContactWithNewPhoto(undefined, card, 'photo', write)).resolves.toBe('saved');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0].media.photo.blobId).toBe('eavlk-up');
    expect(write.mock.calls[1][0]).toBe(card);

    // The account gets no more uploads for the rest of the session.
    expect(supportsContactBlobMedia('f')).toBe(false);
    await writeContactWithNewPhoto(undefined, newCard(), 'photo', vi.fn().mockResolvedValue(undefined));
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('does not retry other refusals', async () => {
    mockUpload.mockResolvedValue({ blobId: 'eavlk-up', type: 'image/jpeg', size: 6 });
    const stale = new JMAPSetError('invalidProperties', 'The following blobIds do not exist or are not accessible: b-logo.');
    const write = vi.fn().mockRejectedValue(stale);
    await expect(writeContactWithNewPhoto(undefined, newCard(), 'photo', write)).rejects.toBe(stale);
    expect(write).toHaveBeenCalledTimes(1);
    expect(supportsContactBlobMedia('f')).toBe(true);
  });

  it('saves the photo inline when the upload fails', async () => {
    mockUpload.mockRejectedValue(new Error('Upload failed: 413'));
    const write = vi.fn().mockResolvedValue(undefined);
    const card = newCard();
    await writeContactWithNewPhoto(undefined, card, 'photo', write);
    expect(write).toHaveBeenCalledWith(card);
  });
});

describe('inlineContactMedia (duplicate, move to another account)', () => {
  it('turns blob entries into data: URIs of their bytes from the card account (Stalwart 1.0)', async () => {
    mockFetchBlob.mockResolvedValue(new Uint8Array(JPEG_BYTES).buffer);
    const media = await inlineContactMedia({
      isShared: true,
      accountId: 'team',
      media: {
        photo: { blobId: 'b-photo', kind: 'photo', mediaType: 'image/jpeg', pref: 1 },
        link: { uri: 'https://x.org/a.png', kind: 'logo' },
      },
    }, 'keep');
    expect(mockFetchBlob).toHaveBeenCalledWith('b-photo', 'photo', 'image/jpeg', 'team');
    expect(media).toEqual({
      photo: { kind: 'photo', mediaType: 'image/jpeg', pref: 1, uri: JPEG_URI },
      link: { uri: 'https://x.org/a.png', kind: 'logo' },
    });
  });

  it('keeps an entry it could not download when asked to', async () => {
    mockFetchBlob.mockRejectedValue(new Error('Failed to fetch blob: 404'));
    const entry = { blobId: 'b-photo', kind: 'photo' };
    expect(await inlineContactMedia({ media: { photo: entry } }, 'keep')).toEqual({ photo: entry });
    expect(await inlineContactMedia({ media: { photo: entry } }, 'drop')).toEqual({});
  });

  it('downloads nothing for a 0.16 card', async () => {
    const media = { photo: { uri: JPEG_URI, kind: 'photo' } };
    expect(await inlineContactMedia({ media }, 'keep')).toBe(media);
    expect(mockFetchBlob).not.toHaveBeenCalled();
  });
});

describe('inlineContactMediaForExport', () => {
  const card = (id: string, media: Record<string, ContactMedia>, extra: Partial<ContactCard> = {}): ContactCard =>
    ({ id, addressBookIds: { b: true }, name: { full: id }, media, ...extra });

  it('fetches the photos of Stalwart 1.0 cards in one Blob/get and writes them into the vCard', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Blob/get', {
        accountId: 'f',
        list: [
          { id: 'b-1', 'data:asBase64': Buffer.from(JPEG_BYTES).toString('base64') },
          { id: 'b-2', 'data:asBase64': 'iVBORw0KGgo=' },
        ],
      }, '0']],
    });
    const cards = [
      card('One', { photo: { blobId: 'b-1', kind: 'photo', mediaType: 'image/jpeg' } }),
      card('Two', { photo: { blobId: 'b-2', kind: 'photo', mediaType: 'image/png' } }),
    ];

    const out = await inlineContactMediaForExport(cards);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [calls, using] = mockRequest.mock.calls[0];
    expect(calls[0]).toEqual(['Blob/get', { accountId: 'f', ids: ['b-1', 'b-2'], properties: ['data:asBase64'] }, '0']);
    expect(using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:blob']);
    expect(out[0].media).toEqual({ photo: { kind: 'photo', mediaType: 'image/jpeg', uri: JPEG_URI } });
    expect(out[1].media).toEqual({ photo: { kind: 'photo', mediaType: 'image/png', uri: 'data:image/png;base64,iVBORw0KGgo=' } });

    const vcf = contactsToVCard(out);
    expect(vcf).toContain(`PHOTO;ENCODING=b;TYPE=image/jpeg:${Buffer.from(JPEG_BYTES).toString('base64')}`);
    expect(vcf).toContain('PHOTO;ENCODING=b;TYPE=image/png:iVBORw0KGgo=');
    expect(mockFetchBlob).not.toHaveBeenCalled();
  });

  // Blob/get answers as Stalwart 1.0 does: sizes or contents of the blobs it
  // has, the rest in notFound.
  function blobServer(sizes: Record<string, number>) {
    mockRequest.mockImplementation(async (calls: Array<[string, { ids: string[]; properties: string[] }, string]>) => {
      const [, args] = calls[0];
      const found = args.ids.filter((id) => id in sizes);
      const list = found.map((id) => (args.properties[0] === 'size'
        ? { id, size: sizes[id] }
        : { id, 'data:asBase64': 'AAAA' }));
      return { methodResponses: [['Blob/get', { accountId: 'f', list, notFound: args.ids.filter((id) => !(id in sizes)) }, '0']] };
    });
  }

  it('asks for sizes first when many photos could make one response too large', async () => {
    const MiB = 1024 * 1024;
    blobServer({ 'b-1': 3 * MiB, 'b-2': 3 * MiB, 'b-3': 300, 'b-4': 400 });
    const cards = ['b-1', 'b-2', 'b-3', 'b-4', 'b-gone'].map((id) =>
      card(id, { photo: { blobId: id, kind: 'photo', mediaType: 'image/jpeg' } }));

    const out = await inlineContactMediaForExport(cards);

    const asked = mockRequest.mock.calls.map(([calls]) => [calls[0][1].properties[0], calls[0][1].ids]);
    // Sizes in one call, then requests of about 4 MiB; a blob the server no
    // longer has is not asked for again.
    expect(asked).toEqual([
      ['size', ['b-1', 'b-2', 'b-3', 'b-4', 'b-gone']],
      ['data:asBase64', ['b-1']],
      ['data:asBase64', ['b-2', 'b-3', 'b-4']],
    ]);
    expect(out.map((c) => c.media?.photo?.uri)).toEqual([
      ...Array(4).fill('data:image/jpeg;base64,AAAA'),
      undefined,
    ]);
    expect(out[4].media).toEqual({});
  });

  it('downloads one by one what a refused Blob/get could not deliver', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['error', { type: 'unknownMethod', description: 'Method Blob/get requires capability urn:ietf:params:jmap:blob' }, '0']],
    });
    mockFetchBlob.mockResolvedValueOnce(new Uint8Array(JPEG_BYTES).buffer).mockRejectedValueOnce(new Error('Failed to fetch blob: 404'));
    const cards = [
      card('One', { photo: { blobId: 'b-1', kind: 'photo', mediaType: 'image/jpeg' } }),
      card('Two', { photo: { blobId: 'b-2', kind: 'photo', mediaType: 'image/png' } }),
    ];

    const out = await inlineContactMediaForExport(cards);

    expect(mockFetchBlob).toHaveBeenCalledTimes(2);
    expect(out[0].media?.photo?.uri).toBe(JPEG_URI);
    expect(out[1].media).toEqual({});
  });

  it('keeps the blob capability out of `using` when the session lacks it', async () => {
    delete session.capabilities['urn:ietf:params:jmap:blob'];
    mockFetchBlob.mockResolvedValue(new Uint8Array(JPEG_BYTES).buffer);
    const out = await inlineContactMediaForExport([card('One', { photo: { blobId: 'b-1', kind: 'photo', mediaType: 'image/jpeg' } })]);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(out[0].media?.photo?.uri).toBe(JPEG_URI);
  });

  it('fetches shared cards from their owner account', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Blob/get', { list: [{ id: 'b-1', 'data:asBase64': 'AAAA' }] }, '0']] });
    await inlineContactMediaForExport([
      card('team:One', { photo: { blobId: 'b-1', kind: 'photo' } }, { isShared: true, accountId: 'team', originalId: 'One' }),
    ]);
    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('team');
  });

  it('leaves 0.16 cards, whose photos are data: URIs, alone', async () => {
    const cards = [card('One', { photo: { uri: JPEG_URI, kind: 'photo', mediaType: 'image/jpeg' } })];
    const out = await inlineContactMediaForExport(cards);
    expect(out[0]).toBe(cards[0]);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockFetchBlob).not.toHaveBeenCalled();
  });
});
