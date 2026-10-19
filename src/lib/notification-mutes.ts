/**
 * Which accounts and folders stay silent when new mail arrives (#78,
 * webmail #1169). Port of the webmail's lib/notification-mutes.ts - keep in sync.
 *
 * An account is either muted or not. A folder can follow its account or carry
 * its own setting, and its own setting always wins: mute one folder in a
 * normal account, or mute a whole account and unmute the folders that still
 * matter. Ids are the server's JMAP account and mailbox ids, which is what the
 * push filter needs; shared-account mailboxes must pass their originalId.
 */

export interface NotificationMutes {
  /** JMAP account ids muted as a whole. */
  accounts: string[];
  /** `accountId/mailboxId` -> true (muted) or false (unmuted). Missing = follow the account. */
  mailboxes: Record<string, boolean>;
}

export const EMPTY_NOTIFICATION_MUTES: NotificationMutes = { accounts: [], mailboxes: {} };

function mailboxKey(accountId: string, mailboxId: string): string {
  return `${accountId}/${mailboxId}`;
}

/** Repairs a value from storage or another build into a usable mutes object. */
export function normalizeNotificationMutes(value: unknown): NotificationMutes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_NOTIFICATION_MUTES;
  const raw = value as { accounts?: unknown; mailboxes?: unknown };
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  const mailboxes: Record<string, boolean> = {};
  if (raw.mailboxes && typeof raw.mailboxes === 'object' && !Array.isArray(raw.mailboxes)) {
    for (const [key, muted] of Object.entries(raw.mailboxes as Record<string, unknown>)) {
      if (typeof muted === 'boolean') mailboxes[key] = muted;
    }
  }
  return { accounts, mailboxes };
}

export function isAccountMuted(mutes: NotificationMutes, accountId: string): boolean {
  return mutes.accounts.includes(accountId);
}

/** The folder's own setting, or undefined when it follows its account. */
export function mailboxMuteOverride(
  mutes: NotificationMutes,
  accountId: string,
  mailboxId: string,
): boolean | undefined {
  return mutes.mailboxes[mailboxKey(accountId, mailboxId)];
}

export function isMailboxMuted(mutes: NotificationMutes, accountId: string, mailboxId: string): boolean {
  return mailboxMuteOverride(mutes, accountId, mailboxId) ?? isAccountMuted(mutes, accountId);
}

/** Mailbox ids of one account with their own setting, split by that setting. */
export function mailboxOverridesForAccount(
  mutes: NotificationMutes,
  accountId: string,
): { muted: string[]; unmuted: string[] } {
  const prefix = mailboxKey(accountId, '');
  const muted: string[] = [];
  const unmuted: string[] = [];
  for (const [key, value] of Object.entries(mutes.mailboxes)) {
    if (!key.startsWith(prefix)) continue;
    (value ? muted : unmuted).push(key.slice(prefix.length));
  }
  return { muted, unmuted };
}

export function setAccountMuted(mutes: NotificationMutes, accountId: string, muted: boolean): NotificationMutes {
  const accounts = mutes.accounts.filter((id) => id !== accountId);
  if (muted) accounts.push(accountId);
  return { ...mutes, accounts };
}

/**
 * Mutes or unmutes one folder. Setting it back to what the account says drops
 * the folder's own setting, so a folder muted and unmuted again follows the
 * account later instead of staying pinned to "unmuted".
 */
export function setMailboxMuted(
  mutes: NotificationMutes,
  accountId: string,
  mailboxId: string,
  muted: boolean,
): NotificationMutes {
  const mailboxes = { ...mutes.mailboxes };
  const key = mailboxKey(accountId, mailboxId);
  if (muted === isAccountMuted(mutes, accountId)) delete mailboxes[key];
  else mailboxes[key] = muted;
  return { ...mutes, mailboxes };
}

/** Drops every folder setting of one account so all its folders follow the account again. */
export function resetMailboxMutes(mutes: NotificationMutes, accountId: string): NotificationMutes {
  const prefix = mailboxKey(accountId, '');
  const mailboxes = Object.fromEntries(
    Object.entries(mutes.mailboxes).filter(([key]) => !key.startsWith(prefix)),
  );
  return { ...mutes, mailboxes };
}
