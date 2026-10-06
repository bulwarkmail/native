import { archiveEmails, getEmails, queryEmails } from '../api/email';
import type { OpScope } from '../api/op-scope';
import type { Mailbox } from '../api/types';
import { isStaleLoad } from './network-error';

export interface ReorganizeArchiveOptions {
  /** The connection and account, taken when the user started it. */
  at: OpScope;
  archiveMailboxId: string;
  mode: 'single' | 'year' | 'month';
  /** The account's own folders as they are now (re-read for each page). */
  mailboxes: () => Mailbox[];
  /** Re-read the folder list (new year/month folders for the next page). */
  refreshMailboxes: () => Promise<void>;
  /**
   * Whether the account is still the one shown and served. Checked before
   * each page: during a switch the folder list (`mailboxes`) can already be
   * another account's, whose folders share ids.
   */
  stillServed: () => boolean;
}

export interface ReorganizeArchiveResult {
  moved: number;
  total: number;
  /** Stopped early because the account changed; `moved` is the progress so far. */
  stopped: boolean;
}

const PAGE = 100;

/**
 * File every message in the archive root into year or year/month folders,
 * a page at a time, every request on `at`. Stops cleanly (no error) when
 * the account is no longer served, or a request was refused unsent because
 * the client moved to another connection.
 */
export async function reorganizeArchive(opts: ReorganizeArchiveOptions): Promise<ReorganizeArchiveResult> {
  const { at, archiveMailboxId, mode } = opts;
  let total = 0;
  let moved = 0;
  try {
    // Each page leaves the archive root, so every query starts at position 0.
    for (;;) {
      if (!opts.stillServed()) return { moved, total, stopped: true };
      const { ids, total: pageTotal } = await queryEmails(archiveMailboxId, { position: 0, limit: PAGE }, at);
      if (moved === 0) total = pageTotal;
      if (ids.length === 0) break;
      const list = await getEmails(ids, at);
      if (!opts.stillServed()) return { moved, total, stopped: true };
      await archiveEmails(
        list.map((e) => ({ id: e.id, receivedAt: e.receivedAt })),
        archiveMailboxId,
        mode,
        opts.mailboxes(),
        at,
      );
      moved += list.length;
      // Newly created year/month folders must be known to the next page, so
      // the same folder is not created twice.
      await opts.refreshMailboxes();
      if (ids.length < PAGE) break;
    }
  } catch (err) {
    if (isStaleLoad(err)) return { moved, total, stopped: true };
    throw err;
  }
  return { moved, total, stopped: false };
}
