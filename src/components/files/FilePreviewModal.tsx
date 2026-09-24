import React from 'react';
import { Alert, Platform } from 'react-native';
import type { File } from 'expo-file-system';
import type { FileNode } from '../../api/types';
import {
  cachePreviewFile, discardPreviewFile, saveLocalFileCopy, shareLocalFile,
} from '../../lib/email-export';
import {
  exceedsPreviewLimit, inAppPreviewKind, type FilePreviewOptions,
} from '../../lib/file-preview';
import { useLocaleStore } from '../../stores/locale-store';
import { AttachmentPreviewModal, type PreviewItem } from '../email/AttachmentPreviewModal';
import { emlPreviewFromBytes } from '../email/use-body-override';

const PREVIEW_OPTIONS: FilePreviewOptions = { inlinePdf: Platform.OS === 'ios' };

export type PreviewableFileNode = Pick<FileNode, 'name' | 'type' | 'size' | 'blobId' | 'accountId'>;

/** Whether a tap on this file opens the in-app preview (else the OS chooser, as before). */
export function canPreviewInApp(node: PreviewableFileNode): boolean {
  return !!node.blobId && inAppPreviewKind(node, PREVIEW_OPTIONS) !== 'none';
}

interface Props {
  /** The file to show; null closes the preview. */
  file: PreviewableFileNode | null;
  onClose: () => void;
}

/**
 * The Files tab's in-app preview: the reader's attachment preview fed from a
 * FileNode. The file is downloaded once, with the same authenticated
 * download as "Download" (token refresh, client certificate), into its own
 * temp folder; Open with, Share and Download then all use that copy instead
 * of fetching it again. The copy is deleted when the preview closes, unless
 * another app got it, in which case the stale-export sweep removes it.
 */
export function FilePreviewModal({ file, onClose }: Props) {
  const t = useLocaleStore((s) => s.t);
  const [item, setItem] = React.useState<PreviewItem | null>(null);
  const [loading, setLoading] = React.useState(false);
  // The downloaded copy of the open preview.
  const session = React.useRef<{ file: File; handedOff: boolean } | null>(null);
  const busy = React.useRef(false);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const blobId = file?.blobId ?? null;
  const accountId = file?.accountId;
  const name = file?.name ?? '';
  const type = file?.type || 'application/octet-stream';
  const size = file?.size;

  React.useEffect(() => {
    if (!blobId) return undefined;
    let cancelled = false;
    setItem(null);
    setLoading(true);

    const build = async (local: File): Promise<PreviewItem> => {
      const kind = inAppPreviewKind({ name, type, size }, PREVIEW_OPTIONS);
      // The node may not report a size; the download does.
      if (kind === 'none' || exceedsPreviewLimit(kind, local.size)) {
        return {
          kind: 'none',
          name,
          mimeType: type,
          notice: kind === 'none' ? undefined : t('files.preview_too_large', 'This file is too large to preview.'),
        };
      }
      switch (kind) {
        case 'text':
          return { kind, name, mimeType: type, text: await local.text() };
        case 'eml':
          return { kind, name, mimeType: type, eml: await emlPreviewFromBytes(await local.bytes()) };
        default:
          return { kind, name, mimeType: type, fileUri: local.uri };
      }
    };

    void (async () => {
      try {
        const local = await cachePreviewFile(blobId, name, type, accountId);
        if (cancelled) {
          discardPreviewFile(local);
          return;
        }
        session.current = { file: local, handedOff: false };
        const next = await build(local);
        if (!cancelled) setItem(next);
      } catch (e) {
        if (cancelled) return;
        Alert.alert(t('files.preview_error', 'Failed to load preview'), e instanceof Error ? e.message : String(e));
        onCloseRef.current();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      const open = session.current;
      session.current = null;
      if (open && !open.handedOff) discardPreviewFile(open.file);
      setItem(null);
      setLoading(false);
    };
  }, [blobId, accountId, name, type, size, t]);

  const act = (run: (local: File) => Promise<void>, handsOff: boolean, failTitle: string) => {
    const open = session.current;
    if (!open || busy.current) return;
    busy.current = true;
    // Another app may keep reading the file after the sheet or viewer returns.
    if (handsOff) open.handedOff = true;
    run(open.file)
      .catch((e) => Alert.alert(failTitle, e instanceof Error ? e.message : String(e)))
      .finally(() => { busy.current = false; });
  };

  return (
    <AttachmentPreviewModal
      item={item}
      loading={loading}
      title={name}
      onClose={onClose}
      onOpenExternal={() => act(
        (local) => shareLocalFile(local, type, name, { keep: true }),
        true,
        t('files.open_error', 'Could not open the file'),
      )}
      onShare={() => act(
        (local) => shareLocalFile(local, type, name, { forceSheet: true, keep: true }),
        true,
        t('files.share_file_error', 'Could not share the file'),
      )}
      onDownload={() => act(
        (local) => saveLocalFileCopy(local, type),
        false,
        t('files.download_error', 'Failed to download'),
      )}
    />
  );
}
