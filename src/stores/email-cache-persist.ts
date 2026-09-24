// Bounds for the email-store's persisted `email-cache` row.
//
// The whole cache is one AsyncStorage row, and Android can't read back a row
// over ~2 MB (CursorWindow). A list row is roughly 0.5-1 KB, so a few hundred
// of them keep the row well under that. Before this the row held every
// window the user had paged through, in every folder and account, and rows
// seeded from the offline body cache carried their full bodies.

import type { Email } from '../api/types';
import type { AccountSnapshot, MailboxSnapshot } from './email-store';

/**
 * Rows kept per folder. Matches the largest "emails per page" choice, so a
 * restored window still covers a full first page and the next refresh can
 * patch it with Email/queryChanges.
 */
export const PERSISTED_ROWS_PER_FOLDER = 100;
/** Rows kept across all folders and accounts. */
export const PERSISTED_ROWS_TOTAL = 500;

/**
 * What the email-store persists: the active account's view in the shape an
 * account switch tucks it away in (its current folder lives in
 * `mailboxSnapshots` once, not also as `emails`), plus the other accounts.
 */
export interface PersistedEmailCache extends AccountSnapshot {
  accountSnapshots: Record<string, AccountSnapshot>;
  activeAccountId: string | null;
}

// A list needs the envelope only; a row seeded from the offline body cache
// also carries the message body.
function listRow(email: Email): Email {
  const {
    bodyValues: _bodyValues,
    htmlBody: _htmlBody,
    textBody: _textBody,
    bodyStructure: _bodyStructure,
    attachments: _attachments,
    headers: _headers,
    ...row
  } = email;
  return row;
}

/**
 * Caps the cache at {@link PERSISTED_ROWS_PER_FOLDER} rows per folder and
 * {@link PERSISTED_ROWS_TOTAL} overall. The active account's current folder
 * is filled first, then its other folders, then the other accounts'. A
 * window is cut to a prefix, which keeps its queryState valid; a folder the
 * budget can't reach is dropped and loads from the server when opened. The
 * active account's entry in `accountSnapshots` is a stale copy of the view
 * and is left out.
 */
export function boundEmailCache(cache: PersistedEmailCache): PersistedEmailCache {
  let budget = PERSISTED_ROWS_TOTAL;
  const bound = (account: AccountSnapshot): AccountSnapshot => {
    const ids = Object.keys(account.mailboxSnapshots);
    const current = account.currentMailboxId;
    if (current && ids.includes(current)) {
      ids.splice(ids.indexOf(current), 1);
      ids.unshift(current);
    }
    const mailboxSnapshots: Record<string, MailboxSnapshot> = {};
    for (const id of ids) {
      const snap = account.mailboxSnapshots[id];
      const rows = Math.min(snap.emails.length, PERSISTED_ROWS_PER_FOLDER, budget);
      if (rows === 0 && snap.emails.length > 0) continue;
      budget -= rows;
      mailboxSnapshots[id] = { ...snap, emails: snap.emails.slice(0, rows).map(listRow) };
    }
    return { ...account, mailboxSnapshots };
  };

  const { accountSnapshots, activeAccountId, ...active } = cache;
  const view = bound(active);
  const others: Record<string, AccountSnapshot> = {};
  for (const [id, account] of Object.entries(accountSnapshots)) {
    if (id !== activeAccountId) others[id] = bound(account);
  }
  return { ...view, accountSnapshots: others, activeAccountId };
}
