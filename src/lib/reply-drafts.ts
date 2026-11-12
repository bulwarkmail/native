// A reply saved as a draft, found from the message it answers. Reply opens it
// again instead of starting a second draft, as Gmail and Outlook do. Port of
// the webmail's lib/reply-drafts.ts and withReplyAllRecipients
// (lib/draft-composer-data.ts).

import type { Email, EmailAddress } from '../api/types';
import type { ComposeDraftContext } from '../navigation/types';
import { stripMessageIdBrackets } from './email-threading';
import { buildReplyRecipients, type ReplySource } from './reply-recipients';

/** The message's own Message-IDs, bare. JMAP sends a list; older code a string. */
function messageIdsOf(email: Pick<Email, 'messageId'>): string[] {
  const raw = email.messageId as unknown;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((id): id is string => typeof id === 'string').map(stripMessageIdBrackets).filter(Boolean);
}

/** Whether `draft` is a reply to `email` (its In-Reply-To names it). */
export function answersMessage(
  draft: Pick<Email, 'inReplyTo' | 'keywords'>,
  email: Pick<Email, 'messageId'>,
): boolean {
  if (!draft.keywords?.$draft) return false;
  const ids = messageIdsOf(email);
  if (ids.length === 0) return false;
  return (draft.inReplyTo ?? []).some((id) => ids.includes(stripMessageIdBrackets(id)));
}

/** The newest of a conversation's drafts that answers `email`. */
export function pickReplyDraft<T extends Pick<Email, 'id' | 'inReplyTo' | 'keywords' | 'receivedAt'>>(
  drafts: readonly T[],
  email: Pick<Email, 'id' | 'messageId'>,
): T | null {
  const candidates = drafts
    .filter((d) => d.id !== email.id && answersMessage(d, email))
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  return candidates[0] ?? null;
}

/**
 * Reply all on the message a draft answers: its other recipients join the
 * draft's, each once, without the user's own addresses.
 */
export function withReplyAllRecipients(
  draft: ComposeDraftContext,
  source: ReplySource,
  ownEmails: string[],
): ComposeDraftContext {
  const all = buildReplyRecipients(source, 'replyAll', ownEmails);
  const have = new Set(
    [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((r) => r.email.trim().toLowerCase()),
  );
  const add = (list: EmailAddress[] | undefined, extra: typeof all.to): EmailAddress[] => {
    const fresh: EmailAddress[] = [];
    for (const r of extra) {
      const key = r.email?.trim().toLowerCase();
      if (!key || have.has(key)) continue;
      have.add(key);
      fresh.push(r.name ? { name: r.name, email: r.email! } : { email: r.email! });
    }
    return [...(list ?? []), ...fresh];
  };
  return { ...draft, to: add(draft.to, all.to), cc: add(draft.cc, all.cc) };
}
