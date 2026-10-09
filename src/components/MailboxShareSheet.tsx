import React from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View } from 'react-native';
import type { Mailbox, MailboxRights } from '../api/types';
import { getMailboxShareWith, setMailboxShare } from '../api/email';
import type { OpScope } from '../api/op-scope';
import { jmapClient } from '../api/jmap-client';
import { isShownAccount, requireShownAccountScope } from '../stores/email-store';
import { useAuthStore } from '../stores/auth-store';
import { useLocaleStore } from '../stores/locale-store';
import { isStaleLoad } from '../lib/network-error';
import { clientServesAccount } from '../lib/active-client-account';
import { sessionSupportsMailShare } from '../lib/capabilities';
import { mailboxShareScope } from '../lib/mailbox-share';
import { useColors } from '../theme/colors';
import { radius, spacing, type ThemePalette } from '../theme/tokens';
import { ShareCollectionSheet, type ShareCollectionTarget } from './ShareCollectionSheet';

interface MailboxShareSheetProps {
  /** The folder to share; null keeps the sheet closed. */
  mailbox: Mailbox | null;
  /** The app account whose folder list `mailbox` came from. */
  ownerAppAccountId: string | null;
  onClose: () => void;
}

/**
 * Whether "Share…" is offered for folder `mb` of app account `owner`, asked
 * at the tap: the account is the one shown and served, the folder's own
 * account has mail:share, and a folder shared with the user may be shared
 * on (`mayShare`).
 */
export function canOfferMailboxShare(mb: Mailbox, owner: string | null): boolean {
  if (!isShownAccount(owner) || !clientServesAccount(owner)) return false;
  if (mb.isShared && mb.myRights?.mayShare !== true) return false;
  return sessionSupportsMailShare(useAuthStore.getState().session, mb.accountId ?? jmapClient.connectedAccountId);
}

interface Opened {
  /** The folder's own account on the connection taken at open. */
  at: OpScope;
  /** Its raw JMAP id in that account. */
  id: string;
  target: ShareCollectionTarget<MailboxRights>;
}

// Share a mail folder (mail:share). Its `shareWith` is not part of the folder
// list, so it is read when the sheet opens and again after every change. The
// connection is taken once, at open, for the folder's own account (the owner's
// for a folder shared with the user): folder and principal ids repeat across
// accounts and servers, so neither the read nor a grant may go out anywhere else.
export function MailboxShareSheet({ mailbox, ownerAppAccountId, onClose }: MailboxShareSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  // Kept current so the open effect runs once per folder, not per render.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    setOpened(null);
    if (!mailbox) return;
    const failed = t('sharing.share_failed', 'Failed to update sharing');
    const fail = (err: unknown) => {
      closeRef.current();
      // Dropped because the client moved to another account: nothing to say.
      if (!isStaleLoad(err)) Alert.alert(failed, err instanceof Error ? err.message : String(err));
    };
    let at: OpScope;
    let id: string;
    try {
      ({ at, id } = mailboxShareScope(mailbox, requireShownAccountScope(ownerAppAccountId)));
    } catch (err) {
      fail(err);
      return;
    }
    let current = true;
    getMailboxShareWith(id, at)
      .then((shareWith) => {
        if (!current) return;
        setOpened({
          at,
          id,
          target: { id, name: mailbox.name, shareWith },
        });
      })
      .catch((err: unknown) => { if (current) fail(err); });
    return () => { current = false; };
    // Opened once per folder and owner; `t` changing must not re-open it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox, ownerAppAccountId]);

  if (!mailbox) return null;

  if (!opened) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.backdrop}>
          <View style={styles.loader}>
            <ActivityIndicator
              size="small"
              color={c.textMuted}
              accessibilityLabel={t('sharing.loading_principals', 'Loading users…')}
            />
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <ShareCollectionSheet
      kind="mailbox"
      target={opened.target}
      onShare={async (_id, principalId, rights) => {
        try {
          await setMailboxShare(opened.id, principalId, rights, opened.at);
        } catch (err) {
          // The connection the sheet opened on was replaced (an account
          // switch or a reconnect): say so in words, not the client's
          // internal reason.
          throw isStaleLoad(err)
            ? new Error(t('sharing.connection_changed', 'The connection changed. Try again.'))
            : err;
        }
      }}
      reload={() => getMailboxShareWith(opened.id, opened.at)}
      onClose={onClose}
    />
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
    loader: { backgroundColor: c.background, borderRadius: radius.lg, padding: spacing.lg },
  });
}
