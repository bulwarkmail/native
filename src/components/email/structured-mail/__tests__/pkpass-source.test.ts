// Port of webmail components/email/structured-mail/__tests__/
// pkpass-source.test.ts at 66c73d0f4, plus the app's download (the JMAP
// client mocked): the cap is enforced on the announced and the real size.
import { describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => ({ respond: (_url: string): Response => new Response(null, { status: 404 }) }));
vi.mock('../../../../api/jmap-client', () => ({
  BLOB_TIMEOUT_MS: 300_000,
  jmapClient: {
    getBlobDownloadUrl: (blobId: string, name?: string, type?: string, accountId?: string) => `https://jmap.example/${accountId ?? 'primary'}/${blobId}/${name}?type=${type}`,
    authenticatedFetch: vi.fn(async (url: string) => fetchMock.respond(url)),
  },
}));

import type { Attachment, Email } from '../../../../api/types';
import { jmapClient } from '../../../../api/jmap-client';
import { MAIL_DATE, boardingPass, eventTicket, zipPass } from '../../../../lib/structured-mail/__tests__/pkpass-fixtures';
import { fetchPassBytes, makePkpassSource, pkpassSource, type FetchPassBytes } from '../pkpass-source';
import { CARD_SOURCES } from '../sources';

const PASS_ATT: Attachment = { blobId: 'blob-pass', size: 3000, name: 'BoardingPass.pkpass', type: 'application/octet-stream' };
const PDF_ATT: Attachment = { blobId: 'blob-pdf', size: 3000, name: 'invoice.pdf', type: 'application/pdf' };

function mail(fields: Partial<Email>): Email {
  return { id: 'm1', threadId: 't', mailboxIds: {}, keywords: {}, size: 1, hasAttachment: true, receivedAt: MAIL_DATE.toISOString(), ...fields } as Email;
}

const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function fetcherFor(blobs: Record<string, Uint8Array | Error>) {
  return vi.fn<FetchPassBytes>(async (blobId: string) => {
    const blob = blobs[blobId];
    if (!blob) throw new Error(`no blob ${blobId}`);
    if (blob instanceof Error) throw blob;
    return toBuffer(blob);
  });
}

function run(email: Email, fetchBytes: FetchPassBytes, signal = new AbortController().signal) {
  return makePkpassSource(fetchBytes)({ email, mailDate: MAIL_DATE, accountId: 'acc-7', signal });
}

describe('pkpassSource', () => {
  it('is registered as a card source', () => {
    expect(CARD_SOURCES).toContain(pkpassSource);
  });

  it('downloads the pass attachment from the message account and returns its card', async () => {
    const fetchBytes = fetcherFor({ 'blob-pass': await zipPass(boardingPass()) });
    const cards = await run(mail({ attachments: [PDF_ATT, PASS_ATT] }), fetchBytes);
    expect(cards).toMatchObject([{ kind: 'flight', source: 'pkpass', reference: 'PK7Q2Z' }]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes).toHaveBeenCalledWith('blob-pass', 'BoardingPass.pkpass', 'application/octet-stream', 'acc-7', 5 * 1024 * 1024 + 1);
  });

  it('downloads nothing that is not a pass, and at most three passes', async () => {
    const bytes = await zipPass(eventTicket());
    const passes = [1, 2, 3, 4].map((i) => ({ ...PASS_ATT, blobId: `p${i}` }));
    const fetchBytes = fetcherFor({ p1: bytes, p2: bytes, p3: bytes, p4: bytes });
    await run(mail({ attachments: [PDF_ATT, { ...PASS_ATT, blobId: 'big', size: 6 * 1024 * 1024 }, ...passes] }), fetchBytes);
    expect(fetchBytes.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2', 'p3']);
  });

  it('reads email.attachments only, never a pass inside an attached message', async () => {
    const fetchBytes = fetcherFor({ 'blob-pass': await zipPass(boardingPass()) });
    const embedded = mail({
      attachments: [{ blobId: 'blob-eml', size: 9000, name: 'forwarded.eml', type: 'message/rfc822' }],
      bodyStructure: {
        partId: '0', blobId: 'root', size: 9000, type: 'multipart/mixed',
        subParts: [{ partId: '2', blobId: 'blob-eml', size: 9000, type: 'message/rfc822', subParts: [{ ...PASS_ATT }] }],
      } as Email['bodyStructure'],
      textBody: [{ ...PASS_ATT }] as Email['textBody'],
    });
    expect(await run(embedded, fetchBytes)).toEqual([]);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('stops between downloads once the message is closed', async () => {
    const bytes = await zipPass(boardingPass());
    const controller = new AbortController();
    const fetchBytes = fetcherFor({ p1: bytes, p2: bytes });
    fetchBytes.mockImplementationOnce(async () => {
      controller.abort();
      return toBuffer(bytes);
    });
    const cards = await run(mail({ attachments: [{ ...PASS_ATT, blobId: 'p1' }, { ...PASS_ATT, blobId: 'p2' }] }), fetchBytes, controller.signal);
    expect(cards).toEqual([]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);

    const late = new AbortController();
    fetchBytes.mockImplementationOnce(async () => {
      late.abort();
      return toBuffer(bytes);
    });
    expect(await run(mail({ attachments: [{ ...PASS_ATT, blobId: 'p1' }] }), fetchBytes, late.signal)).toEqual([]);
  });

  it('gives an empty list, without throwing, when the download fails', async () => {
    const fetchBytes = fetcherFor({ 'blob-pass': new Error('Failed to fetch blob: 500') });
    await expect(run(mail({ attachments: [PASS_ATT] }), fetchBytes)).resolves.toEqual([]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    await expect(run(mail({ attachments: [{ ...PASS_ATT, blobId: '' }] }), fetchBytes)).resolves.toEqual([]);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPassBytes', () => {
  it('downloads the blob from the message account with the client', async () => {
    const bytes = await zipPass(boardingPass());
    fetchMock.respond = () => new Response(toBuffer(bytes), { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    const got = await fetchPassBytes('blob-pass', 'BoardingPass.pkpass', 'application/vnd.apple.pkpass', 'acc-7', 5 * 1024 * 1024 + 1);
    expect(new Uint8Array(got)).toEqual(bytes);
    expect(vi.mocked(jmapClient.authenticatedFetch)).toHaveBeenLastCalledWith(
      'https://jmap.example/acc-7/blob-pass/BoardingPass.pkpass?type=application/vnd.apple.pkpass', undefined, { timeoutMs: 300_000 },
    );
  });

  it('refuses a blob the server says is larger than the cap, and one that turns out larger', async () => {
    fetchMock.respond = () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '5000' } });
    await expect(fetchPassBytes('b', 'x.pkpass', 'application/vnd.apple.pkpass', undefined, 100)).rejects.toThrow(/larger/);
    fetchMock.respond = () => new Response(new Uint8Array(200), { status: 200 });
    await expect(fetchPassBytes('b', 'x.pkpass', 'application/vnd.apple.pkpass', undefined, 100)).rejects.toThrow(/larger/);
    fetchMock.respond = () => new Response(null, { status: 500 });
    await expect(fetchPassBytes('b', 'x.pkpass', 'application/vnd.apple.pkpass', undefined, 100)).rejects.toThrow(/500/);
  });
});
