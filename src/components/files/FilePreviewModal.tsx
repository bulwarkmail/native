import React from 'react';
import type { FileNode } from '../../api/types';
import { AttachmentPreviewModal } from '../email/AttachmentPreviewModal';
import { previewKindOf, useFilePreview } from '../email/use-file-preview';

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
}

/**
 * The Files tab's in-app preview: the shared file preview fed from a
 * FileNode, downloaded with the same authenticated download as "Download"
 * (token refresh, client certificate).
 */
export function FilePreviewModal({ file, onClose, docked = false }: Props) {
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

  return <AttachmentPreviewModal {...preview.modalProps} docked={docked} />;
}
