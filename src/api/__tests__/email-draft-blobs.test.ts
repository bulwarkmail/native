import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { saveDraftVersion, type OutgoingAttachment, type OutgoingEmail } from '../email';
import { initialDraftPartBlobState, liveBlobId, rebaseDraftPartBlobs } from '../../lib/draft-part-blobs';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

/**
 * A tiny server with Stalwart's blob semantics, as measured on 0.16.22 (2026-10-14):
 * an email's part blobIds are derived from that email and stop resolving the
 * moment it is destroyed ("blobId … does not exist on this server"); creating
 * an email copies the referenced bytes into new parts with new blobIds.
 */
function fakeStalwart() {
  let seq = 0;
  const emails = new Map<string, Array<{ blobId: string; name: string; size: number; cid?: string; type: string }>>();
  const live = (blobId: string) => [...emails.values()].some((parts) => parts.some((p) => p.blobId === blobId));
  const seed = (id: string, parts: OutgoingAttachment[]) => {
    emails.set(id, parts.map((p) => ({ blobId: p.blobId, name: p.name, size: p.size ?? 0, cid: p.cid, type: p.type })));
  };
  mockRequest.mockImplementation(async (calls: Array<[string, Record<string, any>, string]>) => {
    const out: Array<[string, unknown, string]> = [];
    let createdId: string | undefined;
    for (const [method, args, callId] of calls) {
      if (method === 'Email/set' && args.create) {
        const create = args.create.draft;
        const dead = (create.attachments ?? []).find((a: { blobId: string }) => !live(a.blobId));
        if (dead) {
          out.push(['Email/set', { notCreated: { draft: {
            type: 'blobNotFound', description: `blobId ${dead.blobId} does not exist on this server.`,
          } } }, callId]);
          continue;
        }
        createdId = `e${++seq}`;
        emails.set(createdId, (create.attachments ?? []).map((a: OutgoingAttachment, i: number) => ({
          blobId: `${createdId}-part${i}`, name: a.name, size: a.size ?? 0, cid: a.cid ? `<${a.cid}>` : undefined, type: a.type,
        })));
        out.push(['Email/set', { created: { draft: { id: createdId } } }, callId]);
      } else if (method === 'Email/set' && args.destroy) {
        for (const id of args.destroy) emails.delete(id);
        out.push(['Email/set', { destroyed: args.destroy }, callId]);
      } else if (method === 'Email/get') {
        if (!createdId || args.ids?.[0] !== '#draft') {
          out.push(['error', { type: 'invalidResultReference' }, callId]);
          continue;
        }
        out.push(['Email/get', { list: [{ id: createdId, attachments: emails.get(createdId) }] }, callId]);
      }
    }
    return { methodResponses: out };
  });
  return { seed, emails };
}

const IMG_A: OutgoingAttachment = { blobId: 'd0-part-a', name: 'schema-a.png', size: 136574, type: 'image/png', disposition: 'inline', cid: 'a@undust.co' };
const IMG_B: OutgoingAttachment = { blobId: 'd0-part-b', name: 'schema-b.png', size: 175155, type: 'image/png', disposition: 'inline', cid: 'b@undust.co' };

const draftWith = (attachments: OutgoingAttachment[]): OutgoingEmail => ({
  from: [{ email: 'me@undust.co' }],
  to: [{ email: 'test@example.invalid' }],
  subject: 'RE: draft with two inline images',
  htmlBody: '<p>x <img src="cid:a@undust.co"> <img src="cid:b@undust.co"></p>',
  textBody: 'x',
  attachments,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveDraftVersion', () => {
  it('reads the new version\'s parts back in the same request, by creation id', async () => {
    fakeStalwart().seed('d0', [IMG_A]);
    const saved = await saveDraftVersion(draftWith([IMG_A]), 'drafts', 'd0');
    const calls = mockRequest.mock.calls[0][0];
    expect(calls.map((c: [string]) => c[0])).toEqual(['Email/set', 'Email/get']);
    expect(calls[1][1].ids).toEqual(['#draft']);
    expect(saved.id).toBe('e1');
    expect(saved.attachments.map((a) => a.blobId)).toEqual(['e1-part0']);
  });

  it('destroys the previous version only after the new one exists', async () => {
    fakeStalwart().seed('d0', [IMG_A]);
    await saveDraftVersion(draftWith([IMG_A]), 'drafts', 'd0');
    const destroyCall = mockRequest.mock.calls[1][0][0];
    expect(destroyCall[0]).toBe('Email/set');
    expect(destroyCall[1].destroy).toEqual(['d0']);
  });

  it('still returns the id when the read-back fails', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['Email/set', { created: { draft: { id: 'e9' } } }, '0'],
      ['error', { type: 'serverFail' }, '1'],
    ] });
    const saved = await saveDraftVersion(draftWith([]), 'drafts');
    expect(saved).toEqual({ id: 'e9', attachments: [] });
  });
});

describe('re-opened draft with inline images: save, save again, send', () => {
  // What ComposeScreen does: buildOutgoing maps each held blobId through the
  // state, saveDraftOnce rebases it on the parts read back.
  async function editSession(rebase: boolean) {
    const server = fakeStalwart();
    server.seed('d0', [IMG_A, IMG_B]); // the draft as deposited (IMAP APPEND or an earlier save)
    let state = initialDraftPartBlobState();
    let draftId = 'd0';
    const outgoing = () => draftWith([IMG_A, IMG_B].map((a) => ({ ...a, blobId: liveBlobId(state, a.blobId) })));
    for (let i = 0; i < 2; i++) {
      const sent = outgoing();
      const saved = await saveDraftVersion(sent, 'drafts', draftId);
      draftId = saved.id;
      if (rebase) state = rebaseDraftPartBlobs(state, sent.attachments ?? [], saved.attachments);
    }
    return { server, draftId };
  }

  it('reproduces the bug without the rebase: the second save references the destroyed draft\'s parts', async () => {
    await expect(editSession(false)).rejects.toThrow('blobId d0-part-a does not exist on this server.');
  });

  it('keeps every save (and so the send, which builds the same attachments) on live blobs', async () => {
    const { server, draftId } = await editSession(true);
    expect([...server.emails.keys()]).toEqual([draftId]);
    expect(server.emails.get(draftId)!.map((p) => p.name)).toEqual(['schema-a.png', 'schema-b.png']);
  });
});
