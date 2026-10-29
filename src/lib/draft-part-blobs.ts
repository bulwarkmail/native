// Keep a re-opened draft's attachments pointing at blobs that still exist.
//
// A draft's attachments and inline images are MIME parts of that draft, and a
// part's blobId lives only as long as the message that holds it: once a save
// creates the next version and destroys the previous one, the server forgets
// the old part blobs (Stalwart answers `blobNotFound`, "blobId … does not
// exist on this server"). The composer was seeded with those part blobIds, so
// without a re-point the second save of a re-opened draft - and any send
// after its first save - failed (webmail #849, second half).
//
// Upload blobs are only a reprieve: the server keeps an unreferenced upload
// for a limited time, so every attachment is re-pointed at the parts of the
// version each save creates.

import type { Attachment } from '../api/types';
import type { OutgoingAttachment } from '../api/email';
import { stripMessageIdBrackets } from './email-threading';

const normCid = (cid?: string | null) => (cid ? stripMessageIdBrackets(cid).trim().toLowerCase() : '');

/**
 * Pair each sent attachment with the part of the newly created version that
 * carries the same content: inline parts by Content-ID, the rest by name and
 * size. Each new part is claimed at most once. Returns sent blobId → new blobId.
 */
export function matchDraftParts(
  sent: readonly OutgoingAttachment[],
  fresh: readonly Pick<Attachment, 'blobId' | 'name' | 'size' | 'cid'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  const claimed = new Set<number>();
  const claim = (s: OutgoingAttachment, test: (p: (typeof fresh)[number]) => boolean) => {
    if (out.has(s.blobId)) return;
    const i = fresh.findIndex((p, idx) => !claimed.has(idx) && !!p.blobId && test(p));
    if (i === -1) return;
    claimed.add(i);
    out.set(s.blobId, fresh[i].blobId);
  };
  for (const s of sent) {
    const cid = normCid(s.cid);
    if (cid) claim(s, (p) => normCid(p.cid) === cid);
  }
  for (const s of sent) {
    claim(s, (p) => (p.name || '') === (s.name || '') && (s.size == null || p.size === s.size));
  }
  return out;
}

export interface DraftPartBlobState {
  /** blobId an attachment entry holds → blobId to send for it now. */
  live: Map<string, string>;
}

export function initialDraftPartBlobState(): DraftPartBlobState {
  return { live: new Map() };
}

/** The blobId to put on the wire for an entry that holds `blobId`. */
export function liveBlobId(state: DraftPartBlobState, blobId: string): string {
  return state.live.get(blobId) ?? blobId;
}

/**
 * After a save: point every attachment that was sent at the matching part of
 * the version just created. Those parts live exactly as long as the saved
 * draft, so the next save or the send always references live blobs - whether
 * the entry came from the previous version (dies with it) or from an upload
 * (an unreferenced upload expires on the server). Blobs that could not be
 * matched keep their id: the next save then fails loudly (and, with
 * create-before-destroy, never loses the draft) instead of silently dropping
 * an attachment.
 */
export function rebaseDraftPartBlobs(
  state: DraftPartBlobState,
  sent: readonly OutgoingAttachment[],
  fresh: readonly Pick<Attachment, 'blobId' | 'name' | 'size' | 'cid'>[],
): DraftPartBlobState {
  const pairs = matchDraftParts(sent, fresh);
  if (pairs.size === 0) return state;
  const live = new Map(state.live);
  const current = new Set(state.live.values());
  for (const [held, sentId] of state.live) {
    const next = pairs.get(sentId);
    if (next) live.set(held, next);
  }
  for (const [sentId, next] of pairs) {
    // An entry sent under its own blobId for the first time.
    if (!current.has(sentId)) live.set(sentId, next);
  }
  return { live };
}

/**
 * The composer's dirty snapshot with its body replaced. Opening a draft whose
 * inline images get hydrated rewrites the editor body (normalised DOM HTML,
 * data URLs for `cid:` images); that rewrite is not an edit, so the baseline
 * has to follow it - comparing against the raw server HTML instead made every
 * re-opened draft with inline images look edited, and the autosave replaced
 * it (and destroyed the opened version) two seconds after opening.
 */
export function withSnapshotBody(snapshot: string, body: string): string {
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, body });
  } catch {
    return snapshot;
  }
}
