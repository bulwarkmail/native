// The account an open composer belongs to. A notification tap or deep link
// can switch the active account while the composer stays mounted, and the
// JMAP client only ever serves the active account's session, so the composer
// pins its owner at mount and refuses to write while another account is
// active.

export interface ComposerAccount {
  /** Account registry id. */
  appAccountId: string;
  /** The login's primary JMAP account id; '' when not known yet. */
  jmapAccountId: string;
}

export function isComposerAccountActive(
  owner: ComposerAccount,
  activeAppAccountId: string | null,
): boolean {
  return owner.appAccountId === activeAppAccountId;
}

/**
 * Who owns the composer being mounted: a reopened draft belongs to the
 * registry account whose JMAP account it lives in. A draft from a shared
 * account inside the active login has no registry entry of its own and
 * stays with the active account, as does every new message.
 */
export function composerOwnerAtMount(params: {
  draftJmapAccountId?: string;
  activeAppAccountId: string | null;
  activeJmapAccountId: string | null;
  accounts: Array<{ id: string; jmapAccountId?: string }>;
}): ComposerAccount | null {
  const { draftJmapAccountId, activeAppAccountId, activeJmapAccountId, accounts } = params;
  if (!activeAppAccountId) return null;
  if (draftJmapAccountId) {
    const entry = accounts.find((a) => a.jmapAccountId === draftJmapAccountId);
    if (entry) return { appAccountId: entry.id, jmapAccountId: draftJmapAccountId };
  }
  const active = accounts.find((a) => a.id === activeAppAccountId);
  return {
    appAccountId: activeAppAccountId,
    jmapAccountId: activeJmapAccountId ?? active?.jmapAccountId ?? '',
  };
}
