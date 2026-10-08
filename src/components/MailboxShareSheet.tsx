import React from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View } from 'react-native';
import type { Mailbox, MailboxRights } from '../api/types';
import { getMailboxShareWith, setMailboxShare } from '../api/email';
import { inAccount, type OpScope } from '../api/op-scope';
import { requireShownAccountScope } from '../stores/email-store';
import { useLocaleStore } from '../stores/locale-store';
import { isStaleLoad } from '../lib/network-error';
import { plainDisplayText } from '../lib/display-text';
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
    try {
      at = inAccount(
        requireShownAccountScope(ownerAppAccountId),
        mailbox.isShared ? mailbox.accountId : undefined,
      );
    } catch (err) {
      fail(err);
      return;
    }
    const id = mailbox.originalId ?? mailbox.id;
    let current = true;
    getMailboxShareWith(id, at)
      .then((shareWith) => {
        if (!current) return;
        setOpened({
          at,
          id,
          target: { id, name: plainDisplayText(mailbox.name), shareWith },
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
      onShare={(_id, principalId, rights) => setMailboxShare(opened.id, principalId, rights, opened.at)}
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
