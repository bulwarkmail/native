import { describe, it, expect } from 'vitest';
import {
  initialDraftPartBlobState, liveBlobId, matchDraftParts, rebaseDraftPartBlobs, withSnapshotBody,
} from '../draft-part-blobs';
import type { OutgoingAttachment } from '../../api/email';

const inline = (blobId: string, cid: string, name = 'img.png', size = 10): OutgoingAttachment => ({
  blobId, cid, name, size, type: 'image/png', disposition: 'inline',
});
const file = (blobId: string, name: string, size: number): OutgoingAttachment => ({
  blobId, name, size, type: 'application/pdf', disposition: 'attachment',
});

describe('matchDraftParts', () => {
  it('pairs inline parts by Content-ID, brackets and case aside', () => {
    const pairs = matchDraftParts(
      [inline('old-a', 'a@x'), inline('old-b', 'b@x')],
      [
        { blobId: 'new-b', cid: '<B@x>', name: 'img.png', size: 10 },
        { blobId: 'new-a', cid: '<a@x>', name: 'img.png', size: 10 },
      ],
    );
    expect(pairs).toEqual(new Map([['old-a', 'new-a'], ['old-b', 'new-b']]));
  });

  it('pairs file attachments by name and size, claiming each new part once', () => {
    const pairs = matchDraftParts(
      [file('old-1', 'q.pdf', 5), file('old-2', 'q.pdf', 5), file('old-3', 'r.pdf', 7)],
      [
        { blobId: 'new-r', name: 'r.pdf', size: 7 },
        { blobId: 'new-q1', name: 'q.pdf', size: 5 },
        { blobId: 'new-q2', name: 'q.pdf', size: 5 },
      ],
    );
    expect(pairs.get('old-1')).toBe('new-q1');
    expect(pairs.get('old-2')).toBe('new-q2');
    expect(pairs.get('old-3')).toBe('new-r');
  });

  it('leaves a part it cannot find unpaired', () => {
    expect(matchDraftParts([file('old', 'gone.pdf', 1)], [{ blobId: 'n', name: 'other.pdf', size: 1 }]).size).toBe(0);
  });
});

describe('rebaseDraftPartBlobs (webmail #849, second half)', () => {
  it('follows the draft across successive saves so no save sends a destroyed part', () => {
    // Re-opened draft D0 with one inline image and one PDF.
    let state = initialDraftPartBlobState();
    const sentAt = () => [inline(liveBlobId(state, 'd0-img'), 'img@x'), file(liveBlobId(state, 'd0-pdf'), 'q.pdf', 5)];

    // Save 1 sends D0's parts (D0 is still alive), creates D1, destroys D0.
    expect(sentAt().map((a) => a.blobId)).toEqual(['d0-img', 'd0-pdf']);
    state = rebaseDraftPartBlobs(state, sentAt(), [
      { blobId: 'd1-img', cid: '<img@x>', name: 'img.png', size: 10 },
      { blobId: 'd1-pdf', name: 'q.pdf', size: 5 },
    ]);
    // Save 2 / send must reference D1's parts, not D0's dead ones.
    expect(sentAt().map((a) => a.blobId)).toEqual(['d1-img', 'd1-pdf']);
    state = rebaseDraftPartBlobs(state, sentAt(), [
      { blobId: 'd2-img', cid: '<img@x>', name: 'img.png', size: 10 },
      { blobId: 'd2-pdf', name: 'q.pdf', size: 5 },
    ]);
    expect(sentAt().map((a) => a.blobId)).toEqual(['d2-img', 'd2-pdf']);
  });

  it('re-points uploads too: an upload expires once nothing references it', () => {
    let state = initialDraftPartBlobState();
    const sent = () => [inline(liveBlobId(state, 'd0-img'), 'img@x'), file(liveBlobId(state, 'upload-1'), 'new.pdf', 3)];
    state = rebaseDraftPartBlobs(state, sent(), [
      { blobId: 'd1-img', cid: '<img@x>', name: 'img.png', size: 10 },
      { blobId: 'd1-new', name: 'new.pdf', size: 3 },
    ]);
    expect(sent().map((a) => a.blobId)).toEqual(['d1-img', 'd1-new']);
  });

  it('leaves the state alone when nothing was sent', () => {
    const state = initialDraftPartBlobState();
    expect(rebaseDraftPartBlobs(state, [], [{ blobId: 'p', name: 'a.pdf', size: 1 }])).toBe(state);
  });

  it('keeps the old id when the read-back came back empty (next save fails loudly, nothing is lost)', () => {
    const state = initialDraftPartBlobState();
    const next = rebaseDraftPartBlobs(state, [inline('d0-img', 'img@x')], []);
    expect(liveBlobId(next, 'd0-img')).toBe('d0-img');
  });
});

describe('withSnapshotBody', () => {
  it('replaces only the body of a composer snapshot', () => {
    const snap = JSON.stringify({ to: [['A', 'a@x', null]], cc: [], bcc: [], subject: 'S', body: '<p>raw</p>', att: ['b1'] });
    expect(JSON.parse(withSnapshotBody(snap, '<p>normalised</p>'))).toEqual({
      to: [['A', 'a@x', null]], cc: [], bcc: [], subject: 'S', body: '<p>normalised</p>', att: ['b1'],
    });
  });

  it('keeps the key order, so an unchanged composer still compares equal', () => {
    const make = (body: string) => JSON.stringify({ to: [], cc: [], bcc: [], subject: 'S', body, att: [] });
    expect(withSnapshotBody(make('<p>raw</p>'), '<p>x</p>')).toBe(make('<p>x</p>'));
  });
});
