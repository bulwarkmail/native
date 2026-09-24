import type { Attachment, Email } from '../api/types';

/**
 * Attachment chips for message-list rows (webmail 0e1c34cd, #1089).
 *
 * The list request only carries `hasAttachment`: asking the server for
 * `attachments` there makes Stalwart read and parse every message's raw blob.
 * A row with a paperclip asks for its own parts once it is rendered. Rows
 * that render together (one page, one scroll step) are coalesced into a
 * single Email/get per account, and the answer is cached: an email's parts
 * never change.
 */

/**
 * The parts the sender actually attached. Anything marked inline or
 * referenced by a Content-ID (signature logos, spacers, tracking pixels) is
 * dropped, as are parts without a filename, which can't be labelled or saved.
 */
export function realAttachments(attachments?: readonly Attachment[] | null): Attachment[] {
  if (!attachments?.length) return [];
  return attachments.filter((a) => a.disposition !== 'inline' && !a.cid && !!a.name);
}

/**
 * Long names are unreadable cut at the tail; the extension is the most
 * identifying part, so keep it and elide the middle.
 */
export function shortAttachmentName(name: string, max = 18): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const head = name.slice(0, Math.max(1, max - ext.length - 1));
  return `${head}…${ext}`;
}

export type AttachmentKind = 'image' | 'pdf' | 'sheet' | 'archive' | 'document' | 'other';

export function attachmentKind(type: string | undefined, name: string | undefined): AttachmentKind {
  const probe = `${type ?? ''} ${name ?? ''}`.toLowerCase();
  if (/^image\//.test(probe)) return 'image';
  if (/pdf/.test(probe)) return 'pdf';
  if (/sheet|excel|csv/.test(probe)) return 'sheet';
  if (/zip|compress|tar|rar|7z/.test(probe)) return 'archive';
  if (/word|document|rtf|text\//.test(probe)) return 'document';
  return 'other';
}

type Listener = (attachments: Attachment[]) => void;

/** Fetches the parts of a batch of emails from one account. */
export type FetchListAttachments = (emailIds: string[]) => Promise<Map<string, Attachment[]>>;

/**
 * Loader handed to list rows: starts a lazy fetch of the row's parts from the
 * account it lives in, returns its cancel.
 */
export type LoadListAttachments = (email: Email, onLoad: Listener) => () => void;

interface Queue {
  /** Waiting for the next flush, by email id. */
  pending: Map<string, Set<Listener>>;
  /** Sent, answer not back yet: a row rendering now joins instead of re-asking. */
  inFlight: Map<string, Set<Listener>>;
  timer: ReturnType<typeof setTimeout> | null;
}

// Long enough to collect every row of one render or scroll step, short
// enough that nobody sees the chips arrive late.
const FLUSH_DELAY_MS = 50;
const CACHE_LIMIT = 2000;

const queues = new Map<string, Queue>();
const cache = new Map<string, Attachment[]>();

const cacheKey = (scope: string, emailId: string) => `${scope}\u0000${emailId}`;

function remember(key: string, attachments: Attachment[]) {
  cache.delete(key);
  cache.set(key, attachments);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function flush(scope: string, fetch: FetchListAttachments, queue: Queue) {
  queue.timer = null;
  const batch = new Map<string, Set<Listener>>();
  for (const [id, listeners] of queue.pending) {
    if (listeners.size === 0) continue;
    batch.set(id, listeners);
    queue.inFlight.set(id, listeners);
  }
  queue.pending.clear();
  if (batch.size === 0) return;

  fetch([...batch.keys()])
    .then((found) => {
      for (const [id, listeners] of batch) {
        // An id the server did not return is gone; remember that too so a
        // stale row does not ask again on every remount.
        const attachments = found.get(id) ?? [];
        remember(cacheKey(scope, id), attachments);
        for (const listener of listeners) listener(attachments);
      }
    })
    .catch(() => {
      // Not cached: the next render of the row tries again.
    })
    .finally(() => {
      for (const id of batch.keys()) queue.inFlight.delete(id);
    });
}

/**
 * Ask for one email's attachment parts. `scope` names the account the email
 * lives in (local account + JMAP account), `fetch` loads a batch from it.
 * `onLoad` runs once with the parts, synchronously when cached. Returns a
 * cancel that drops the request if the row goes away first: a row scrolled
 * past before the flush costs nothing.
 */
export function requestListAttachments(
  scope: string,
  fetch: FetchListAttachments,
  emailId: string,
  onLoad: Listener,
): () => void {
  const cached = cache.get(cacheKey(scope, emailId));
  if (cached) {
    onLoad(cached);
    return () => {};
  }

  let queue = queues.get(scope);
  if (!queue) {
    queue = { pending: new Map(), inFlight: new Map(), timer: null };
    queues.set(scope, queue);
  }
  let listeners = queue.inFlight.get(emailId) ?? queue.pending.get(emailId);
  if (!listeners) {
    listeners = new Set();
    queue.pending.set(emailId, listeners);
  }
  listeners.add(onLoad);
  if (queue.pending.has(emailId) && !queue.timer) {
    const q = queue;
    queue.timer = setTimeout(() => flush(scope, fetch, q), FLUSH_DELAY_MS);
  }

  const joined = listeners;
  return () => {
    joined.delete(onLoad);
  };
}

/** Test hook: forget every cached answer and queued request. */
export function resetListAttachmentsForTests() {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
  queues.clear();
  cache.clear();
}
