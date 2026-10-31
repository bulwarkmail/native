import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { FileNode } from '../../api/types';
import { AttachmentPreviewModal } from '../email/AttachmentPreviewModal';
import { previewKindOf, useFilePreview } from '../email/use-file-preview';
import { ChevronLeft, ChevronRight } from '../icons';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

export type PreviewableFileNode = Pick<FileNode, 'name' | 'type' | 'size' | 'blobId' | 'accountId'>;

/** Whether a tap on this file opens the in-app preview (else the OS chooser, as before). */
export function canPreviewInApp(node: PreviewableFileNode): boolean {
  return !!node.blobId && previewKindOf({ name: node.name, type: node.type || '', size: node.size }) !== 'none';
}

interface Props {
  /** The file to show; null closes the preview. */
  file: PreviewableFileNode | null;
  onClose: () => void;
  /** Show it in a side pane instead of a full-screen modal. */
  docked?: boolean;
  /**
   * Step to the folder's previous / next previewable file; the buttons show
   * when either is given and the missing one is disabled (webmail
   * previewNeighbours).
   */
  onPrevious?: () => void;
  onNext?: () => void;
}

/**
 * The Files tab's in-app preview: the shared file preview fed from a
 * FileNode, downloaded with the same authenticated download as "Download"
 * (token refresh, client certificate).
 */
export function FilePreviewModal({ file, onClose, docked = false, onPrevious, onNext }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const preview = useFilePreview({ onClose });
  const { open, reset } = preview;

  const blobId = file?.blobId ?? null;
  const accountId = file?.accountId;
  const name = file?.name ?? '';
  const type = file?.type || 'application/octet-stream';
  const size = file?.size;

  React.useEffect(() => {
    if (!blobId) return undefined;
    void open({ from: 'blob', blobId, accountId, name, type, size });
    return reset;
  }, [blobId, accountId, name, type, size, open, reset]);

  const headerActions = onPrevious || onNext ? (
    <>
      <Pressable
        onPress={onPrevious}
        disabled={!onPrevious}
        style={styles.button}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('files.previous_file', 'Previous file')}
        accessibilityState={{ disabled: !onPrevious }}
      >
        <ChevronLeft size={22} color={onPrevious ? c.text : c.textMuted} />
      </Pressable>
      <Pressable
        onPress={onNext}
        disabled={!onNext}
        style={styles.button}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('files.next_file', 'Next file')}
        accessibilityState={{ disabled: !onNext }}
      >
        <ChevronRight size={22} color={onNext ? c.text : c.textMuted} />
      </Pressable>
    </>
  ) : undefined;

  return <AttachmentPreviewModal {...preview.modalProps} docked={docked} headerActions={headerActions} />;
}

const styles = StyleSheet.create({
  // The preview header's own button size.
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
