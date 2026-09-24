import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText } from 'lucide-react-native';
import type { Attachment, Email, Mailbox } from '../../api/types';
import { getEmailAttachments } from '../../api/email';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useTypography } from '../../theme/dynamic';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useAuthStore } from '../../stores/auth-store';
import { accountIdOfRow } from '../../stores/email-store';
import { accountScopedId } from '../../lib/thread-utils';
import {
  attachmentKind, realAttachments, requestListAttachments, shortAttachmentName,
  type AttachmentKind, type LoadListAttachments,
} from '../../lib/list-attachments';
import { getAttachmentDisplayName, previewKindFor } from '../../lib/attachment-display';
import { cacheBlobFile, downloadAttachment, fetchBlobBytes, shareAttachment, shareLocalFile } from '../../lib/email-export';
import { AttachmentPreviewModal, type PreviewItem } from './AttachmentPreviewModal';

/** How many chips a row shows before collapsing the rest into a count. */
const MAX_CHIPS = 2;

const ICONS: Record<AttachmentKind, typeof FileIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  document: FileText,
  other: FileIcon,
};

function iconColor(kind: AttachmentKind, c: ThemePalette): string {
  switch (kind) {
    case 'image': return c.tags.purple.dot;
    case 'pdf': return c.tags.red.dot;
    case 'sheet': return c.tags.green.dot;
    case 'archive': return c.tags.amber.dot;
    case 'document': return c.tags.blue.dot;
    default: return c.textMuted;
  }
}

/**
 * The row's attachment parts: the ones the email already carries (a message
 * opened before), else loaded lazily when it has a paperclip.
 */
function useListAttachments(email: Email, load?: LoadListAttachments): Attachment[] | undefined {
  const [loaded, setLoaded] = React.useState<{ key: string; attachments: Attachment[] } | null>(null);
  const needsLoad = !!load && !!email.hasAttachment && !email.attachments;
  // Rows of a list spanning accounts can share an id (#1082).
  const key = accountScopedId(email, email.id);

  React.useEffect(() => {
    if (!needsLoad || !load) return undefined;
    return load(email, (attachments) => setLoaded({ key, attachments }));
    // The row's email object is replaced on every keyword change; only a
    // different message needs a different answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsLoad, load, key]);

  if (email.attachments) return email.attachments;
  return loaded?.key === key ? loaded.attachments : undefined;
}

interface ChipsProps {
  email: Email;
  load?: LoadListAttachments;
  onOpen: (email: Email, attachment: Attachment) => void;
  /** Selection mode: taps belong to the row. */
  disabled?: boolean;
}

/**
 * Attachment chips under a list row's preview (webmail 0e1c34cd): the files
 * the sender attached, two at a time with the rest as a count, each opening
 * that file directly.
 */
export const ListAttachmentChips = React.memo(function ListAttachmentChips({
  email, load, onOpen, disabled,
}: ChipsProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dyn = useTypography();
  const attachments = useListAttachments(email, load);
  const real = React.useMemo(() => realAttachments(attachments), [attachments]);
  if (real.length === 0) return null;

  const shown = real.slice(0, MAX_CHIPS);
  const overflow = real.length - shown.length;
  return (
    <View style={styles.row}>
      {shown.map((a, i) => {
        const kind = attachmentKind(a.type, a.name);
        const Icon = ICONS[kind];
        return (
          <Pressable
            key={`${a.blobId}-${i}`}
            // A disabled Pressable never takes the touch, so in selection
            // mode the tap falls through to the row.
            disabled={disabled}
            onPress={() => onOpen(email, a)}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
            accessibilityRole="button"
            accessibilityLabel={a.name}
          >
            <Icon size={12} color={iconColor(kind, c)} />
            <Text style={[styles.name, dyn.caption]} numberOfLines={1}>{shortAttachmentName(a.name ?? '')}</Text>
          </Pressable>
        );
      })}
      {overflow > 0 && (
        <View style={styles.more}>
          <Text style={[styles.moreText, dyn.caption]}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
});

export interface ListAttachmentOpenerHandle {
  /** Open one attachment of a list row; `accountId` is the owning JMAP account. */
  open: (email: Email, attachment: Attachment, accountId?: string) => void;
}

interface OpenTarget {
  email: Email;
  attachment: Attachment;
  accountId?: string;
  name: string;
  type: string;
}

/**
 * Opens a list-row attachment the way the reader's chips do: the "attachment
 * click action" setting either saves it or previews it in-app (images, PDFs,
 * text), and anything that can't be previewed goes to the platform viewer.
 * Holds the preview modal, so the list itself never re-renders for it.
 */
export const ListAttachmentOpener = React.forwardRef<ListAttachmentOpenerHandle>(
  function ListAttachmentOpener(_props, ref) {
    const t = useLocaleStore((s) => s.t);
    const [preview, setPreview] = React.useState<PreviewItem | null>(null);
    const [loading, setLoading] = React.useState(false);
    const target = React.useRef<OpenTarget | null>(null);
    const busy = React.useRef(false);

    const run = React.useCallback(async (fn: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      try {
        await fn();
      } catch (e) {
        Alert.alert(
          t('email_viewer.attachment_failed', 'Could not open attachment'),
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        busy.current = false;
      }
    }, [t]);

    const openExternal = React.useCallback((it: OpenTarget) => run(
      () => shareAttachment(it.attachment.blobId, it.attachment.name, it.attachment.type, it.email, it.accountId),
    ), [run]);

    React.useImperativeHandle(ref, () => ({
      open: (email, attachment, accountId) => {
        if (busy.current) return;
        const name = getAttachmentDisplayName(attachment.name, attachment.type);
        const type = attachment.type || 'application/octet-stream';
        const it: OpenTarget = { email, attachment, accountId, name, type };
        target.current = it;

        if (useSettingsStore.getState().mailAttachmentAction === 'download') {
          void run(() => downloadAttachment(attachment.blobId, attachment.name, attachment.type, email, accountId));
          return;
        }
        const kind = previewKindFor({ name, type });
        if (kind !== 'image' && kind !== 'pdf' && kind !== 'text') {
          void openExternal(it);
          return;
        }
        setPreview(null);
        setLoading(true);
        void run(async () => {
          try {
            if (kind === 'text') {
              const bytes = await fetchBlobBytes(attachment.blobId, attachment.name, attachment.type, accountId);
              setPreview({ kind, name, mimeType: type, text: new TextDecoder('utf-8').decode(bytes) });
            } else {
              const file = await cacheBlobFile(attachment.blobId, name, type, accountId);
              setPreview({ kind, name, mimeType: type, fileUri: file.uri });
            }
          } finally {
            setLoading(false);
          }
        });
      },
    }), [run, openExternal]);

    return (
      <AttachmentPreviewModal
        item={preview}
        loading={loading}
        onClose={() => { setPreview(null); setLoading(false); }}
        onOpenExternal={() => { if (target.current) void openExternal(target.current); }}
        onShare={() => {
          const it = target.current;
          if (!it || !preview?.fileUri) return;
          const { File } = require('expo-file-system') as typeof import('expo-file-system');
          void shareLocalFile(new File(preview.fileUri), it.type, it.name, { forceSheet: true }).catch(() => undefined);
        }}
      />
    );
  },
);

/**
 * Wiring for a mail list's chips: the lazy loader and the opener for rows of
 * the folder on screen, whose messages live in that folder's account (a
 * shared folder's owner, else the user's own). Both callbacks are stable
 * while the folder's account is, so memoized rows keep their memo. Render
 * `<ListAttachmentOpener ref={openerRef} />` once next to the list.
 */
export function useListRowAttachments(mailboxes: readonly Mailbox[], currentMailboxId: string | null) {
  const localAccountId = useAuthStore((s) => s.activeAccountId);
  const current = currentMailboxId ? mailboxes.find((m) => m.id === currentMailboxId) : undefined;
  const jmapAccountId = current?.isShared ? current.accountId : undefined;
  const openerRef = React.useRef<ListAttachmentOpenerHandle>(null);

  const loadAttachments = React.useCallback<LoadListAttachments>((email, onLoad) => {
    // A row of an "All folders" list or a tag view lives in its own account,
    // whatever folder is open (#1082, #1038).
    const accountId = email.jmapAccountId ? accountIdOfRow(email) : jmapAccountId;
    const scope = `${localAccountId ?? ''}\u0000${accountId ?? ''}`;
    return requestListAttachments(scope, async (ids) => {
      // The request goes out through the active account's client: if the
      // user switched accounts meanwhile, fail (and don't cache) instead of
      // asking the other server.
      if (useAuthStore.getState().activeAccountId !== localAccountId) {
        throw new Error('Account switched');
      }
      return getEmailAttachments(ids, accountId);
    }, email.id, onLoad);
  }, [localAccountId, jmapAccountId]);

  const openAttachment = React.useCallback((email: Email, attachment: Attachment) => {
    openerRef.current?.open(email, attachment, email.jmapAccountId ? accountIdOfRow(email) : jmapAccountId);
  }, [jmapAccountId]);

  return { loadAttachments, openAttachment, openerRef };
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      maxWidth: 180,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
    },
    chipPressed: { backgroundColor: c.surfaceHover },
    name: { ...typography.caption, color: c.textSecondary, flexShrink: 1 },
    more: {
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
    },
    moreText: { ...typography.caption, color: c.textMuted },
  });
}
