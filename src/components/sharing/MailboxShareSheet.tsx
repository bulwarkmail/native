import React from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import type { Mailbox } from '../../api/types';
import { getMailboxShareWith, setMailboxShare } from '../../api/mailbox-sharing';
import { detectPreset, MAILBOX_PRESETS, type ShareMailboxRights } from '../../lib/delegation/share-rights';
import { useLocaleStore } from '../../stores/locale-store';
import { useColors } from '../../theme/colors';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { ShareCollectionSheet, type ShareableCollection, type SharePreset } from './ShareCollectionSheet';
import { mailboxShareRef } from '../../lib/mailbox-share';

interface MailboxShareSheetProps {
  /** Null hides the sheet. */
  mailbox: Mailbox | null;
  /** The folder's name as the sidebar shows it (Inbox, Sent… localised). */
  name?: string;
  onClose: () => void;
}

/**
 * Share a mail folder with other people (webmail mailbox-share-dialog.tsx):
 * the folder's shareWith is read when the sheet opens, since it is not part
 * of the folder list, and then the same sheet as for calendars and address
 * books picks people and roles.
 */
export function MailboxShareSheet({ mailbox, name, onClose }: MailboxShareSheetProps) {
  const t = useLocaleStore((s) => s.t);
  const c = useColors();
  const [collection, setCollection] = React.useState<ShareableCollection<ShareMailboxRights> | null>(null);

  React.useEffect(() => {
    setCollection(null);
    if (!mailbox) return undefined;
    let cancelled = false;
    const { mailboxId, accountId } = mailboxShareRef(mailbox);
    getMailboxShareWith(mailboxId, accountId).then(
      (shareWith) => {
        if (!cancelled) setCollection({ id: mailboxId, name: name || mailbox.name, shareWith });
      },
      (err: unknown) => {
        if (cancelled) return;
        Alert.alert(
          t('sharing.share_failed', 'Failed to update sharing'),
          err instanceof Error ? err.message : String(err),
        );
        onClose();
      },
    );
    return () => {
      cancelled = true;
    };
    // `name` and `t` only label the sheet; a new folder starts a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox]);

  // The webmail's folder presets: no free/busy for mail.
  const presets = React.useMemo<SharePreset<ShareMailboxRights>[]>(() => [
    { key: 'read', label: t('sharing.preset.read', 'Read only'), rights: MAILBOX_PRESETS.read },
    { key: 'readWrite', label: t('sharing.preset.readWrite', 'Read & write'), rights: MAILBOX_PRESETS.readWrite },
    { key: 'manager', label: t('sharing.preset.manager', 'Manager'), rights: MAILBOX_PRESETS.manager },
  ], [t]);

  if (!mailbox) return null;

  if (!collection) {
    return (
      <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
          <View style={[styles.spinner, { backgroundColor: c.background }]}>
            <ActivityIndicator
              size="small"
              color={c.textMuted}
              accessibilityLabel={t('sharing.loading_principals', 'Loading users…')}
            />
          </View>
        </Pressable>
      </Modal>
    );
  }

  const { accountId } = mailboxShareRef(mailbox);
  return (
    <ShareCollectionSheet
      collection={collection}
      presets={presets}
      addRights={MAILBOX_PRESETS.read}
      // Stalwart 1.0 stores a read grant with the keyword right on.
      detectPreset={(rights) => detectPreset('mailbox', rights)}
      onShare={(mailboxId, principalId, rights) => setMailboxShare(mailboxId, principalId, rights, accountId)}
      onClose={onClose}
    />
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  spinner: { padding: 20, borderRadius: 12 },
});
