import type { CalendarEvent, ContactCard, Email, FileNode } from '../../api/types';
import type { ParsedQuery, SearchKind } from './query-parser';

// "Search everything" (webmail lib/global-search/types.ts, #641): one query
// across mail, contacts, calendar events and files of every signed-in
// account. Every hit carries the login it is reached through
// (`localAccountId`, an account-store id), the JMAP account that owns it and
// the raw server id: ids repeat across accounts (#847), so nothing finds a
// hit again by its id alone.

export type HitSource = 'local' | 'remote';

interface HitBase {
  kind: SearchKind;
  /** Login (account-store id) the item is reached through. */
  localAccountId: string;
  /** JMAP account that owns the item (the login's own, or a shared one). */
  jmapAccountId: string;
  /** Whether that is not the login's own account. */
  shared: boolean;
  /** Raw server id, never namespaced. */
  id: string;
  accountLabel: string;
  title: string;
  /** Folder, address book, calendar or path, shown after the account label. */
  subtitle: string;
  /** ISO time for ordering by recency. */
  date: string | null;
  source: HitSource;
  /** Server the login talks to: the same item reached through two logins is one hit. */
  serverUrl?: string;
}

export interface MailHit extends HitBase {
  kind: 'mail';
  email: Email;
  snippet: { subject: string | null; preview: string | null } | null;
}

export interface ContactHit extends HitBase {
  kind: 'contacts';
  contact: ContactCard;
  /** The id the contacts store lists the card under (namespaced when shared). */
  storeId: string;
}

export interface CalendarHit extends HitBase {
  kind: 'calendar';
  event: CalendarEvent;
  isRecurring: boolean;
}

export interface FileHit extends HitBase {
  kind: 'files';
  node: FileNode;
  /** Folder path the node lives in (`/` for the root). */
  folderPath: string;
  isFolder: boolean;
}

export type GlobalSearchHit = MailHit | ContactHit | CalendarHit | FileHit;

/** One login the search fans out to. */
export interface SearchAccount {
  localAccountId: string;
  label: string;
  email: string;
  serverUrl?: string;
  /** The login the app is connected to right now. */
  active: boolean;
}

export interface RemoteSearchResult {
  hits: GlobalSearchHit[];
  hasMore: boolean;
}

export interface SearchProvider {
  kind: SearchKind;
  /** Hits from what is already in memory: substring match, so partial words work. */
  local: (parsed: ParsedQuery, accounts: SearchAccount[], limit: number) => GlobalSearchHit[];
  /** One login's server hits. Throws on failure; the run turns that into an error row. */
  remote: (parsed: ParsedQuery, account: SearchAccount, options: { limit: number; signal: AbortSignal }) => Promise<RemoteSearchResult>;
}

export interface SearchAccountError {
  localAccountId: string;
  accountLabel: string;
  message: string;
}

export interface KindStatus {
  status: 'idle' | 'loading' | 'done';
  errors: SearchAccountError[];
  hasMore: boolean;
}

export interface SearchOutcome {
  hits: Record<SearchKind, GlobalSearchHit[]>;
  status: Record<SearchKind, KindStatus>;
}

export function emptyOutcome(): SearchOutcome {
  return {
    hits: { mail: [], contacts: [], calendar: [], files: [] },
    status: {
      mail: { status: 'idle', errors: [], hasMore: false },
      contacts: { status: 'idle', errors: [], hasMore: false },
      calendar: { status: 'idle', errors: [], hasMore: false },
      files: { status: 'idle', errors: [], hasMore: false },
    },
  };
}
