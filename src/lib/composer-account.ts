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
 * Whether the composer may write now. `switchAccount` swaps the email
 * store's view (and with it the composer's Drafts/Sent) before the JMAP
 * client has loaded the new session, and the auth store only after, so both
 * must still point at the owner. Without an owner nothing is gated.
 */
export function isComposerOwnerActive(
  owner: ComposerAccount | null,
  authActiveAppAccountId: string | null,
  viewActiveAppAccountId: string | null,
): boolean {
  if (!owner) return true;
  return isComposerAccountActive(owner, authActiveAppAccountId)
    && isComposerAccountActive(owner, viewActiveAppAccountId);
}

/**
 * The JMAP account id an app account had when the client last served it
 * (`AccountEntry.jmapAccountId`), looked up by app account id. Only the
 * owner's own id is ever asked for: JMAP ids repeat across servers, so
 * another account's id could name a different mailbox.
 */
export type RecordedJmapAccountId = (appAccountId: string) => string | null | undefined;

/**
 * The owner is whoever is active when the composer mounts — including for a
 * reopened draft: JMAP account ids are only unique per server, so a draft's
 * id can't safely name a registry account. The live id (passed only while
 * the client serves the active account) wins; on an offline cold start the
 * id recorded for that same app account stands in.
 */
export function composerOwnerAtMount(params: {
  activeAppAccountId: string | null;
  activeJmapAccountId: string | null;
  recordedJmapAccountId?: RecordedJmapAccountId;
}): ComposerAccount | null {
  const { activeAppAccountId, activeJmapAccountId, recordedJmapAccountId } = params;
  if (!activeAppAccountId) return null;
  const jmapAccountId = activeJmapAccountId || recordedJmapAccountId?.(activeAppAccountId) || '';
  return { appAccountId: activeAppAccountId, jmapAccountId };
}

/**
 * The JMAP account a send is queued against, read at send time; '' when
 * none is known, and then the send is refused. The live id counts only while
 * the client serves the owner, so a connection that came up after mount is
 * picked up and one for another account never is. Otherwise the id recorded
 * for the owner's own app account, then the one pinned at mount.
 */
export function queueJmapAccountId(
  owner: ComposerAccount | null,
  params: { liveJmapAccountId: string | null; clientServesOwner: boolean; recorded?: RecordedJmapAccountId },
): string {
  if (!owner) return '';
  if (params.clientServesOwner && params.liveJmapAccountId) return params.liveJmapAccountId;
  return params.recorded?.(owner.appAccountId) || owner.jmapAccountId || '';
}

/** How the "switch back" alert names the owner; never empty. */
export function composerAccountLabel(
  owner: ComposerAccount,
  entry?: { email?: string; displayName?: string; username?: string },
): string {
  return entry?.email || entry?.displayName || entry?.username || owner.appAccountId;
}

export type SwitchBackAction = 'cancel' | 'switch' | 'discard' | 'copyAndClose';

/**
 * What the "account changed" alert offers. Switching back is the way to send
 * or save, but an owner that left the registry (its sign-in failed) or a
 * switch that did not take effect would make it the only exit, trapping the
 * user in the composer. Then the alert offers leaving without a server write:
 * a discard, or copying the text first.
 */
export function composerSwitchBackActions(params: {
  ownerRegistered: boolean;
  switchFailed?: boolean;
}): SwitchBackAction[] {
  if (params.ownerRegistered && !params.switchFailed) return ['cancel', 'switch'];
  return ['cancel', 'discard', 'copyAndClose'];
}

interface ActiveAccountSource {
  getState(): { activeAccountId: string | null };
}

/**
 * A checker that reads the stores at call time. Write-time guards must use
 * this, not a value captured at render: a detached write (a discard that
 * finishes after the composer closed) or one between a store change and the
 * next render would otherwise see a stale "still active".
 */
export function liveComposerOwnerCheck(
  owner: ComposerAccount | null,
  stores: { auth: ActiveAccountSource; view: ActiveAccountSource },
): () => boolean {
  return () => isComposerOwnerActive(
    owner,
    stores.auth.getState().activeAccountId,
    stores.view.getState().activeAccountId,
  );
}
