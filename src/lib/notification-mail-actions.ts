// Archive and Copy code on a new-mail notification, for the JS push task
// (push-background-task.ts). The native path does the same in Kotlin
// (BulwarkNativePushFetcher.archiveEmail, VerificationCode).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email } from '../api/types';
import { listVerificationCode } from './verification-code';

const SETTINGS_STORAGE_KEY = 'webmail:settings:v1';

export type ArchiveMode = 'single' | 'year' | 'month';

/** The settings the notification actions follow: the Archive layout and "Show verification codes". */
export async function notificationActionSettings(): Promise<{ archiveMode: ArchiveMode; showVerificationCodes: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { archiveMode?: unknown; showVerificationCodes?: unknown }) : {};
    const mode = parsed.archiveMode === 'year' || parsed.archiveMode === 'month' ? parsed.archiveMode : 'single';
    return { archiveMode: mode, showVerificationCodes: parsed.showVerificationCodes !== false };
  } catch {
    return { archiveMode: 'single', showVerificationCodes: true };
  }
}

/** The sign-in code a notification offers to copy (the list's chip rule), or null. */
export function notificationCode(
  email: Pick<Email, 'subject' | 'preview' | 'receivedAt'>,
  showVerificationCodes: boolean,
  now = Date.now(),
): string | null {
  return showVerificationCodes ? listVerificationCode(email, now) : null;
}

export interface ArchiveFolderInfo {
  id: string;
  name: string;
  role?: string | null;
  parentId?: string | null;
  myRights?: { mayAddItems?: boolean } | null;
}

/**
 * Where Archive files a message, as the app's own Archive does (archiveEmails
 * in api/email.ts) and the webmail's push action route (archiveDestination):
 * the Archive folder, made with the archive role where there is none, and in
 * "year" or "month" mode the year and month folders in it by the date the
 * message came in on this device. Creation ids resolve in the request that
 * carries the Mailbox/set.
 */
export function planNotificationArchive(
  mailboxes: ArchiveFolderInfo[],
  mode: ArchiveMode,
  receivedAt: string | undefined,
): { destination: string; create: Record<string, Record<string, unknown>> } {
  const create: Record<string, Record<string, unknown>> = {};
  const archive = mailboxes.find((m) => m.role === 'archive')
    ?? mailboxes.find((m) => m.name.toLowerCase() === 'archive');
  let destination = archive?.id ?? '#archive';
  if (!archive) create.archive = { name: 'Archive', parentId: null, role: 'archive' };

  const descend = (name: string, cid: string) => {
    const existing = destination.startsWith('#')
      ? undefined
      : mailboxes.find((m) => m.parentId === destination && m.name === name);
    if (existing) {
      destination = existing.id;
      return;
    }
    create[cid] = { name, parentId: destination };
    destination = `#${cid}`;
  };
  if (mode !== 'single') {
    const parsed = receivedAt ? new Date(receivedAt) : new Date();
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    descend(String(date.getFullYear()), 'year');
    if (mode === 'month') descend(String(date.getMonth() + 1).padStart(2, '0'), 'month');
  }
  return { destination, create };
}

type MethodResponse = [string, Record<string, any>, string];
type Post = (calls: Array<[string, Record<string, unknown>, string]>) => Promise<MethodResponse[]>;

function responseOf(responses: MethodResponse[], name: string, callId: string): Record<string, any> | undefined {
  return responses.find((r) => r[0] === name && r[2] === callId)?.[1];
}

/**
 * Archive from a notification, over `post` (a detached session's JMAP call).
 * A message in Trash or Junk stays where it is, as does one whose Archive
 * folder is read-only. Folders made for a write the server refused are
 * removed again. Twice at most: another client may make the same folder
 * between the read and the write, and then it is there to file into.
 */
export async function archiveFromNotification(
  post: Post,
  accountId: string,
  emailId: string,
  mode: ArchiveMode,
): Promise<'archived' | 'gone' | 'refused'> {
  const read = async () => {
    const res = await post([
      ['Mailbox/get', { accountId, properties: ['id', 'name', 'role', 'parentId', 'myRights'] }, 'm'],
      ['Email/get', { accountId, ids: [emailId], properties: ['id', 'mailboxIds', 'receivedAt'] }, 'e'],
    ]);
    const boxes = responseOf(res, 'Mailbox/get', 'm');
    if (!boxes) throw new Error('Mailbox/get failed');
    const email = (responseOf(res, 'Email/get', 'e')?.list as Array<Pick<Email, 'id' | 'mailboxIds' | 'receivedAt'>> | undefined)?.[0];
    return { mailboxes: (boxes.list ?? []) as ArchiveFolderInfo[], email };
  };

  let { mailboxes, email } = await read();
  if (!email) return 'gone';
  const bins = new Set(mailboxes.filter((m) => m.role === 'trash' || m.role === 'junk').map((m) => m.id));
  if (Object.keys(email.mailboxIds ?? {}).some((id) => bins.has(id))) return 'refused';

  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = planNotificationArchive(mailboxes, mode, email.receivedAt);
    if (mailboxes.find((m) => m.id === plan.destination)?.myRights?.mayAddItems === false) return 'refused';
    const res = await post([
      ...(Object.keys(plan.create).length > 0
        ? [['Mailbox/set', { accountId, create: plan.create }, 'folders'] as [string, Record<string, unknown>, string]]
        : []),
      ['Email/set', { accountId, update: { [emailId]: { mailboxIds: { [plan.destination]: true } } } }, 'write'],
    ]);
    const folders = responseOf(res, 'Mailbox/set', 'folders');
    const written = responseOf(res, 'Email/set', 'write');
    if (written?.updated && emailId in written.updated) return 'archived';
    // Nothing went in: no empty folder left behind, deepest first.
    const created = ['month', 'year', 'archive']
      .map((cid) => folders?.created?.[cid]?.id as string | undefined)
      .filter((id): id is string => !!id);
    if (created.length > 0) {
      await post([['Mailbox/set', { accountId, destroy: created }, 'cleanup']]).catch(() => undefined);
    }
    if (Object.keys(folders?.notCreated ?? {}).length === 0 || attempt > 0) return 'refused';
    ({ mailboxes } = await read());
  }
  return 'refused';
}
