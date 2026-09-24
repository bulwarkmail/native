import type { Email } from '../api/types';

// Port of the webmail's `lib/thread-utils.ts` (tag id extraction, thread
// grouping helpers) trimmed to what the native list needs.

/** Active prefix for new keyword tags written to JMAP. */
export const KEYWORD_PREFIX = '$label:';
/** Legacy prefix still recognised when reading. */
export const KEYWORD_PREFIX_LEGACY = '$color:';

/**
 * Every tag id set on a message. Reads both the current `$label:` prefix and
 * the legacy `$color:` prefix; a tag written under both spellings is one tag.
 */
export function getEmailTagIds(keywords: Record<string, boolean> | undefined): string[] {
  if (!keywords) return [];
  const tags = new Set<string>();
  for (const key of Object.keys(keywords)) {
    if (keywords[key] !== true) continue;
    if (key.startsWith(KEYWORD_PREFIX)) tags.add(key.slice(KEYWORD_PREFIX.length));
    else if (key.startsWith(KEYWORD_PREFIX_LEGACY)) tags.add(key.slice(KEYWORD_PREFIX_LEGACY.length));
  }
  return [...tags];
}

/**
 * Every tag anywhere in a thread, deduplicated. A collapsed thread row stands
 * in for all its messages, so it has to account for all their tags.
 */
export function getThreadTagIds(emails: Email[]): string[] {
  const tags = new Set<string>();
  for (const email of emails) {
    for (const tag of getEmailTagIds(email.keywords)) tags.add(tag);
  }
  return [...tags];
}

/** The tag id inside a keyword, or null when the keyword is not a tag. */
export function tagIdFromKeyword(keyword: string): string | null {
  for (const prefix of [KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY]) {
    if (keyword.startsWith(prefix)) {
      const id = keyword.slice(prefix.length);
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/**
 * A message or thread id scoped by the account stamp of a row from a list
 * that spans accounts: JMAP ids are only unique per account (Stalwart hands
 * out small per-account counters), so keys built from bare ids would merge
 * two accounts' rows. Unstamped rows keep the bare id (webmail
 * `threadKeyFor`).
 */
export function accountScopedId(email: Pick<Email, 'jmapAccountId'>, id: string): string {
  return email.jmapAccountId ? `${email.jmapAccountId}:${id}` : id;
}

/** Key a message groups under: its thread, or itself when threading is off. */
export function threadKeyOf(email: Email, disableThreading: boolean): string {
  return accountScopedId(email, disableThreading ? email.id : email.threadId || email.id);
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function isPinned(email: Email): boolean {
  return !!email.keywords?.$pinned;
}

/**
 * Collapses same-thread messages to one row each. Each thread's row is its
 * *newest* message (by receivedAt) regardless of the list's sort direction,
 * and takes the position of whichever of its messages the list showed first —
 * RFC 8621 §4.4.3 thread-collapsing semantics, the same rule the webmail's
 * `sortThreadGroups` applies. Rows whose thread carries a `$pinned` message
 * stay on top, mirroring the pinned-first server sort.
 */
export function collapseThreads(
  emails: Email[],
  disableThreading: boolean,
  opts: { pinnedFirst?: boolean } = {},
): Email[] {
  const pinnedFirst = opts.pinnedFirst !== false;
  const groups = new Map<string, Email[]>();
  for (const e of emails) {
    const key = threadKeyOf(e, disableThreading);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const rows: Array<{ email: Email; pinned: boolean; order: number }> = [];
  let order = 0;
  for (const list of groups.values()) {
    let newest = list[0];
    for (const e of list) {
      if (time(e.receivedAt) > time(newest.receivedAt)) newest = e;
    }
    rows.push({ email: newest, pinned: pinnedFirst && list.some(isPinned), order: order++ });
  }
  if (pinnedFirst) {
    rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order);
  }
  return rows.map((r) => r.email);
}

/** Every loaded message of each thread, keyed by thread key. */
export function groupByThread(emails: Email[], disableThreading: boolean): Map<string, Email[]> {
  const groups = new Map<string, Email[]>();
  for (const e of emails) {
    const key = threadKeyOf(e, disableThreading);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}

/**
 * Expands selected representative ids to every loaded message of their
 * threads, so batch actions on "3 selected" conversations touch all their
 * messages rather than one each. Ids that are not in `emails` pass through.
 */
export function expandThreadSelection(
  ids: Iterable<string>,
  emails: Email[],
  disableThreading: boolean,
): string[] {
  const wanted = new Set(ids);
  if (disableThreading) return [...wanted];
  const byId = new Map(emails.map((e) => [e.id, e]));
  const keys = new Set<string>();
  for (const id of wanted) {
    const e = byId.get(id);
    if (e) keys.add(threadKeyOf(e, false));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of emails) {
    if (keys.has(threadKeyOf(e, false)) && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e.id);
    }
  }
  for (const id of wanted) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
