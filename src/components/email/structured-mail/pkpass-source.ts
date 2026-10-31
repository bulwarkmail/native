// Mirrors webmail components/email/structured-mail/pkpass-source.ts at
// 66c73d0f4; keep the two in step. App: the webmail's client reads the
// blob as a stream and stops one byte past the cap; React Native's fetch
// can't stream, so the download is refused when the server announces more
// than the cap and the bytes are counted once they are in.
import { PKPASS_MAX_BYTES, PKPASS_MAX_PER_MAIL, isPkpassAttachment, readPkpass } from '../../../lib/structured-mail/pkpass';
import type { StructuredCard } from '../../../lib/structured-mail';
import type { CardSource } from './sources';

/** Download a blob of at most `maxBytes` from the message's JMAP account. */
export type FetchPassBytes = (blobId: string, name: string | undefined, type: string, accountId: string | undefined, maxBytes: number) => Promise<ArrayBuffer>;

/** The app's download: the JMAP client's authenticated blob fetch, capped. */
export const fetchPassBytes: FetchPassBytes = async (blobId, name, type, accountId, maxBytes) => {
  // Lazy: the client pulls in native modules the pure parts and their tests must not load.
  const { jmapClient, BLOB_TIMEOUT_MS } = await import('../../../api/jmap-client');
  const url = jmapClient.getBlobDownloadUrl(blobId, name, type, accountId);
  const response = await jmapClient.authenticatedFetch(url, undefined, { timeoutMs: BLOB_TIMEOUT_MS });
  if (!response.ok) throw new Error(`Failed to fetch blob: ${response.status}`);
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) throw new Error('blob larger than its listed size');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error('blob larger than its listed size');
  return bytes;
};

/**
 * Cards from Apple Wallet passes attached to a trusted message. Reads only
 * `email.attachments`, the message's own parts: never the parts the viewer
 * unwraps from an attached .eml or a TNEF winmail.dat, which the sender's
 * authentication says nothing about. At most three passes, each downloaded
 * from the message's own JMAP account and capped at 5 MB; stops between
 * downloads once the message is closed. Never throws.
 */
export function makePkpassSource(fetchBytes: FetchPassBytes): CardSource {
  return async ({ email, mailDate, accountId, signal }) => {
    try {
      if (signal.aborted) return [];
      const attachments = (Array.isArray(email.attachments) ? email.attachments : [])
        .filter((att) => !!att && typeof att.blobId === 'string' && att.blobId !== '' && isPkpassAttachment(att))
        .slice(0, PKPASS_MAX_PER_MAIL);
      const cards: StructuredCard[] = [];
      for (const att of attachments) {
        if (signal.aborted) return [];
        let bytes: ArrayBuffer;
        try {
          // One byte past the cap, so a blob larger than its listed size is noticed and refused.
          bytes = await fetchBytes(att.blobId, att.name, att.type, accountId, PKPASS_MAX_BYTES + 1);
        } catch {
          continue;
        }
        cards.push(...await readPkpass(bytes, { mailDate }));
      }
      return signal.aborted ? [] : cards;
    } catch {
      return [];
    }
  };
}

export const pkpassSource: CardSource = makePkpassSource(fetchPassBytes);
