// Reply on a message that already has a reply draft opens that draft
// (webmail mail-app resumeReplyDraft). The lookup is one round trip; when it
// fails or finds nothing, Reply starts a new message as before.

import type { Email } from '../api/types';
import type { ComposeDraftContext } from '../navigation/types';
import { getFullEmail, getThreadDrafts } from '../api/email';
import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';
import { draftContextFromEmail } from './draft-context';
import { readCachedIdentities } from './identity-cache';
import { pickReplyDraft, withReplyAllRecipients } from './reply-drafts';

export interface ResumeReplyDeps {
  getThreadDrafts: (threadId: string, accountId?: string) => Promise<Email[]>;
  getFullEmail: (id: string, accountId?: string) => Promise<Email>;
  ownEmails: () => Promise<string[]>;
}

async function ownEmails(): Promise<string[]> {
  const active = useAccountStore.getState().getActiveAccount();
  const out = new Set<string>();
  for (const e of [active?.email, active?.username, jmapClient.username]) {
    if (e && e.includes('@')) out.add(e);
  }
  for (const i of await readCachedIdentities(useAccountStore.getState().activeAccountId)) {
    if (i.email) out.add(i.email);
  }
  return Array.from(out);
}

const defaultDeps: ResumeReplyDeps = { getThreadDrafts, getFullEmail, ownEmails };

/**
 * The saved reply to `source` as composer params, or null to start a new
 * reply. Reply all adds the message's other recipients to the draft's.
 */
export async function findReplyDraftContext(
  mode: 'reply' | 'replyAll',
  source: Email,
  ownerAccountId?: string,
  deps: ResumeReplyDeps = defaultDeps,
): Promise<ComposeDraftContext | null> {
  if (source.keywords?.$draft || !source.threadId || !source.messageId?.length) return null;
  try {
    const drafts = await deps.getThreadDrafts(source.threadId, ownerAccountId);
    const found = pickReplyDraft(drafts, source);
    if (!found) return null;
    const full = await deps.getFullEmail(found.id, ownerAccountId);
    const ctx = draftContextFromEmail(full, ownerAccountId);
    if (mode !== 'replyAll') return ctx;
    return withReplyAllRecipients(ctx, {
      from: source.from ?? undefined,
      replyToAddresses: source.replyTo ?? undefined,
      to: source.to ?? undefined,
      cc: source.cc ?? undefined,
    }, await deps.ownEmails());
  } catch {
    return null;
  }
}
