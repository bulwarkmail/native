import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OutgoingEmail, SavedDraftVersion } from '../api/email';
import { makeKeyedLane } from './lane';

// A composer whose draft can't reach the server (the session expired, or the
// connection is gone) keeps it on the device here, so closing the composer or
// losing the app process doesn't lose the text. Once the account's session is
// up again (the Outbox flush: session up, server checked, online), each kept
// draft goes to the account's Drafts and the user is told it is there. A
// composer still open saves its own draft and is skipped.

const KEY_PREFIX = 'compose-rescue:v1:';

export interface RescuedDraft {
  /** The composer it came from. */
  id: string;
  savedAt: number;
  /** The message as the composer built it for a draft. */
  outgoing: OutgoingEmail;
  draftsMailboxId: string;
  /** JMAP account of a group's Drafts; absent for the login's own. */
  jmapAccountId?: string;
  /** The draft version saved before, replaced when this one is saved. */
  previousDraftId?: string;
  previousDraftAccountId?: string;
}

/** The server didn't take the draft, and it was kept on the device instead. */
export class DraftKeptOnDeviceError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'DraftKeptOnDeviceError';
  }
}

const key = (accountId: string) => `${KEY_PREFIX}${accountId}`;

async function read(accountId: string): Promise<RescuedDraft[]> {
  try {
    const raw = await AsyncStorage.getItem(key(accountId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RescuedDraft[]) : [];
  } catch {
    return [];
  }
}

async function write(accountId: string, drafts: RescuedDraft[]): Promise<void> {
  if (drafts.length === 0) await AsyncStorage.removeItem(key(accountId));
  else await AsyncStorage.setItem(key(accountId), JSON.stringify(drafts));
}

// Reads and writes of one account's list run one after another.
const serial = makeKeyedLane();

/** Keep (or replace) a composer's draft on the device for an account (app registry id). */
export function rescueDraft(accountId: string, draft: RescuedDraft): Promise<void> {
  return serial(accountId, async () => {
    const drafts = (await read(accountId)).filter((d) => d.id !== draft.id);
    await write(accountId, [...drafts, draft]);
  }).catch((err) => console.warn('[compose-rescue] keep failed', err));
}

/** Drop a composer's kept draft: it reached the server, was sent or discarded. */
export function forgetRescuedDraft(accountId: string, id: string): Promise<void> {
  return serial(accountId, async () => {
    const drafts = await read(accountId);
    if (drafts.some((d) => d.id === id)) await write(accountId, drafts.filter((d) => d.id !== id));
  }).catch(() => undefined);
}

/** Drop every kept draft of an account that was signed out. */
export function clearRescuedDrafts(accountId: string): Promise<void> {
  return serial(accountId, () => AsyncStorage.removeItem(key(accountId))).catch(() => undefined);
}

export function rescuedDrafts(accountId: string): Promise<RescuedDraft[]> {
  return serial(accountId, () => read(accountId));
}

// Composers open in this process, which save their own drafts.
const openComposers = new Set<string>();

export function composerOpened(id: string): void {
  openComposers.add(id);
}

export function composerClosed(id: string): void {
  openComposers.delete(id);
}

export interface FlushDeps {
  save: (draft: RescuedDraft) => Promise<SavedDraftVersion | unknown>;
  /** Called once per flush that saved at least one draft. */
  saved: (count: number) => void;
}

const flushing = new Set<string>();

/**
 * Save the kept drafts of an account to its Drafts. Call only while the
 * client serves that account's session. A draft the server doesn't take
 * stays for the next try. Resolves to how many were saved.
 */
export async function flushRescuedDrafts(accountId: string, deps: FlushDeps): Promise<number> {
  if (flushing.has(accountId)) return 0;
  flushing.add(accountId);
  let count = 0;
  try {
    for (const draft of await rescuedDrafts(accountId)) {
      if (openComposers.has(draft.id)) continue;
      try {
        await deps.save(draft);
      } catch (err) {
        console.warn('[compose-rescue] save failed', err);
        continue;
      }
      await forgetRescuedDraft(accountId, draft.id);
      count += 1;
    }
  } finally {
    flushing.delete(accountId);
  }
  if (count > 0) deps.saved(count);
  return count;
}
