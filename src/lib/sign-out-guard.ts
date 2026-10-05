// Asks before a sign-out or account removal throws away queued sends.
// Counting reads storage by key prefix, so accounts whose queue was never
// hydrated this session still count. Every state counts: `queued` and
// `failed` were never sent, `uncertain` and `sending` may or may not have been.
// A `sending` row is named apart: its request is in flight and may still go
// out whatever the user picks.

import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';

const KEY_PREFIX = 'webmail:sendqueue:v1:';

/** True only when at least one account has something queued. */
export function signOutNeedsConfirm(counts: readonly number[]): boolean {
  return counts.some((n) => n > 0);
}

/** Queued sends per account id, from the persisted rows. A storage error counts as 1: ask rather than risk it. */
export async function countQueuedSends(appAccountIds: readonly string[]): Promise<number[]> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return appAccountIds.map(() => 1);
  }
  return appAccountIds.map((id) => {
    const prefix = `${KEY_PREFIX}${id}:`;
    return keys.filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':')).length;
  });
}

export interface QueuedSendStates {
  /** Rows in any state. */
  total: number;
  /** Rows whose send is in flight now: they may still go out whatever the user picks. */
  sending: number;
}

/**
 * Like countQueuedSends, with the `sending` rows counted apart. A storage
 * error counts as one unsent row (ask rather than risk it); a row that cannot
 * be read counts as unsent.
 */
export async function countQueuedSendStates(appAccountIds: readonly string[]): Promise<QueuedSendStates[]> {
  let rows: ReadonlyArray<readonly [string, string | null]>;
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(KEY_PREFIX));
    rows = keys.length ? await AsyncStorage.multiGet(keys) : [];
  } catch {
    return appAccountIds.map(() => ({ total: 1, sending: 0 }));
  }
  return appAccountIds.map((id) => {
    const prefix = `${KEY_PREFIX}${id}:`;
    const mine = rows.filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'));
    const sending = mine.filter(([, raw]) => {
      try {
        return (JSON.parse(raw ?? 'null') as { state?: unknown } | null)?.state === 'sending';
      } catch {
        return false;
      }
    }).length;
    return { total: mine.length, sending };
  });
}

type Choice = 'cancel' | 'outbox' | 'confirm';

function ask(title: string, message: string, confirmLabel: string): Promise<Choice> {
  return new Promise<Choice>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve('cancel') },
        { text: t('outbox.open', 'Open Outbox'), onPress: () => resolve('outbox') },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve('confirm') },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') },
    );
  });
}

/** The unsent count (sending rows apart) and, when one is in flight, that it may still go out. */
function queuedMessage(unsent: number, sending: number): string {
  const parts: string[] = [];
  if (unsent > 0) {
    parts.push(t(
      'outbox.signout_confirm',
      '{count, plural, one {# unsent message will be deleted. Sign out anyway?} other {# unsent messages will be deleted. Sign out anyway?}}',
      { count: unsent },
    ));
  }
  if (sending > 0) parts.push(t('outbox.signout_sending', 'A message is being sent and may still go out.'));
  return parts.join('\n\n');
}

/**
 * Counts queued sends and, when there are any, asks. Resolves `{ go, discard }`:
 * go is true when the sign-out may proceed (nothing queued, or the user chose
 * the confirm button); discard is true only when something was queued and the
 * user confirmed. "Open Outbox" and Cancel resolve go false.
 */
async function guard(
  ids: readonly string[],
  openOutbox: () => void,
  confirmLabel: string,
  titleAndMessage?: (queuedText: string) => { title: string; message: string },
): Promise<{ go: boolean; discard: boolean; none: boolean }> {
  const states = await countQueuedSendStates(ids);
  if (!signOutNeedsConfirm(states.map((s) => s.total))) return { go: true, discard: false, none: true };
  const total = states.reduce((a, s) => a + s.total, 0);
  const sending = states.reduce((a, s) => a + s.sending, 0);
  const text = queuedMessage(total - sending, sending);
  const { title, message } = titleAndMessage
    ? titleAndMessage(text)
    : { title: t('outbox.title', 'Outbox'), message: text };
  const choice = await ask(title, message, confirmLabel);
  if (choice === 'outbox') openOutbox();
  return { go: choice === 'confirm', discard: choice === 'confirm', none: false };
}

/** Sign out of one account (the active one), asking first when it has queued sends. */
export async function signOutWithGuard(appAccountId: string | null, openOutbox: () => void): Promise<void> {
  const r = await guard(appAccountId ? [appAccountId] : [], openOutbox, t('sidebar.sign_out', 'Sign out'));
  if (!r.go) return;
  await useAuthStore.getState().logout(r.discard ? { discardQueuedSends: true } : undefined);
}

/** Sign out of every account; the counts are summed. */
export async function signOutAllWithGuard(openOutbox: () => void): Promise<void> {
  const ids = useAccountStore.getState().accounts.map((a) => a.id);
  const r = await guard(ids, openOutbox, t('sidebar.sign_out', 'Sign out'));
  if (!r.go) return;
  await useAuthStore.getState().logoutAll(r.discard ? { discardQueuedSends: true } : undefined);
}

export interface RemoveAccountPrompt {
  title: string;
  /** The existing "Remove ..." confirmation text. */
  message: string;
  confirmLabel: string;
  /** Called once the removal is confirmed, just before it starts. */
  onConfirmed?: () => void;
}

/**
 * Remove an account behind one prompt. Nothing queued: the existing confirm
 * (title, message, Cancel / confirm). Queued sends: the same text plus the
 * unsent-messages warning, with Cancel / Open Outbox / confirm.
 */
export async function removeAccountWithGuard(
  appAccountId: string,
  openOutbox: () => void,
  prompt: RemoveAccountPrompt,
): Promise<void> {
  const r = await guard(
    [appAccountId], openOutbox, prompt.confirmLabel,
    (queued) => ({ title: prompt.title, message: `${prompt.message}\n\n${queued}` }),
  );
  let go = r.go;
  if (r.none) {
    go = await new Promise<boolean>((resolve) => {
      Alert.alert(prompt.title, prompt.message, [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: prompt.confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
  }
  if (!go) return;
  prompt.onConfirmed?.();
  await useAuthStore.getState().removeAccount(appAccountId, r.discard ? { discardQueuedSends: true } : undefined);
}
