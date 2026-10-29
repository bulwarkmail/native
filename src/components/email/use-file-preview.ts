import React from 'react';
import { Alert, Platform } from 'react-native';
import { File } from 'expo-file-system';
import type { Email } from '../../api/types';
import {
  cachePreviewFile, copyPreviewFile, discardPreviewFile, saveLocalFileCopy, shareAttachment,
  shareBytes, shareLocalFile, writePreviewFile,
} from '../../lib/email-export';
import {
  exceedsPreviewLimit, inAppPreviewKind, type FilePreviewOptions,
} from '../../lib/file-preview';
import type { PreviewKind } from '../../lib/file-preview';
import { markdownToHtml } from '../../lib/markdown-html';
import { imageViewerHtml, mediaViewerHtml, pdfViewerHtml, type ViewerColors } from '../../lib/preview-viewer-html';
import { closePdfPages, openPdfPages, PdfOpenError } from '../../lib/pdf-pages';
import { openZip, ZipEncryptedError } from '../../lib/zip-preview';
import { useLocaleStore } from '../../stores/locale-store';
import { useColors, useResolvedTheme } from '../../theme/colors';
import type { PreviewItem } from './AttachmentPreviewModal';
import { emlPreviewFromBytes } from './use-body-override';

export const PREVIEW_OPTIONS: FilePreviewOptions = { platform: Platform.OS === 'ios' ? 'ios' : 'android' };

interface PreviewSourceBase {
  /** Display name, shown in the header and given to the cached copy. */
  name: string;
  type: string;
  size?: number | null;
  /** Name for "Download" (the attachment filename template); defaults to `name`. */
  saveName?: string;
}

/** Where a previewed file comes from. */
export type PreviewSource = PreviewSourceBase & (
  | { from: 'blob'; blobId: string; accountId?: string; email?: Email | null }
  | { from: 'bytes'; bytes: Uint8Array }
  | { from: 'local'; uri: string }
);

/** The preview a tap on `source` opens, or 'none' when it goes to another app. */
export function previewKindOf(source: Pick<PreviewSource, 'name' | 'type' | 'size'>): PreviewKind {
  return inAppPreviewKind(source, PREVIEW_OPTIONS);
}

/** Copy the source into a preview folder of its own (see cachePreviewFile). */
async function materialize(source: PreviewSource): Promise<File> {
  switch (source.from) {
    case 'blob':
      return cachePreviewFile(source.blobId, source.name, source.type, source.accountId);
    case 'bytes':
      return writePreviewFile(source.bytes, source.name, source.type);
    case 'local':
      return copyPreviewFile(source.uri, source.name, source.type);
  }
}

/** Hand a file the app doesn't show to the app that owns its type ("Open with"). */
function handOff(source: PreviewSource): Promise<void> {
  switch (source.from) {
    case 'blob':
      return shareAttachment(source.blobId, source.name, source.type, source.email, source.accountId);
    case 'bytes':
      return shareBytes(source.bytes, source.name, source.type);
    case 'local':
      // A copy, so the cleanup after the hand-off never removes the original.
      return shareLocalFile(copyPreviewFile(source.uri, source.name, source.type), source.type, source.name);
  }
}

// The viewer page sits next to the file it shows (see preview-viewer-html).
function writeViewer(local: File, html: string): string {
  const page = new File(local.parentDirectory, '__preview.html');
  if (page.exists) page.delete();
  page.create();
  page.write(html);
  return page.uri;
}

interface Notices {
  tooLarge: string;
  pdfProtected: string;
  pdfUnreadable: string;
  zipProtected: string;
  zipUnreadable: string;
}

async function buildItem(
  kind: Exclude<PreviewKind, 'none'>,
  source: PreviewSource,
  local: File,
  notices: Notices,
  colors: ViewerColors,
): Promise<PreviewItem> {
  const base = { name: source.name, mimeType: source.type };
  // The source may not know its size; the copy does.
  if (exceedsPreviewLimit(kind, local.size)) return { ...base, kind: 'none', notice: notices.tooLarge };
  switch (kind) {
    case 'text':
      return { ...base, kind, text: await local.text() };
    case 'markdown':
      return { ...base, kind, html: markdownToHtml(await local.text()) };
    case 'html':
      return { ...base, kind, html: await local.text() };
    case 'eml':
      return { ...base, kind, eml: await emlPreviewFromBytes(await local.bytes()) };
    case 'archive':
      try {
        return { ...base, kind, archive: await openZip(await local.bytes()) };
      } catch (e) {
        return { ...base, kind: 'none', notice: e instanceof ZipEncryptedError ? notices.zipProtected : notices.zipUnreadable };
      }
    case 'image':
      return { ...base, kind, fileUri: local.uri, viewerUri: writeViewer(local, imageViewerHtml(local.name, colors)) };
    case 'video':
    case 'audio':
      return { ...base, kind, fileUri: local.uri, viewerUri: writeViewer(local, mediaViewerHtml(kind, local.name, colors)) };
    case 'pdf': {
      // iOS's WebView shows the PDF itself; Android renders its pages.
      if (Platform.OS !== 'android') return { ...base, kind, fileUri: local.uri };
      try {
        const pages = await openPdfPages(local.uri);
        return { ...base, kind, fileUri: local.uri, viewerUri: writeViewer(local, pdfViewerHtml(local.name, pages, colors)) };
      } catch (e) {
        const protectedPdf = e instanceof PdfOpenError && e.reason === 'protected';
        return { ...base, kind: 'none', notice: protectedPdf ? notices.pdfProtected : notices.pdfUnreadable };
      }
    }
    default:
      return { ...base, kind, fileUri: local.uri };
  }
}

/**
 * One in-app preview: picks how a file is shown, downloads it once into a
 * temp folder of its own, and serves Open with, Share and Download from that
 * copy. Files the app can't show go straight to another app. The copy is
 * deleted when the preview closes or the next one opens, unless another app
 * got it, which may still be reading it; the stale-export sweep removes
 * those. Used by every place that opens a file: the reader's chips, the
 * list's chips, the Files tab and compose.
 *
 * Render `<AttachmentPreviewModal {...preview.modalProps} />` next to it.
 */
export function useFilePreview(opts: {
  /** Called when the preview closes: the close button, or a download that failed. */
  onClose?: () => void;
} = {}) {
  const t = useLocaleStore((s) => s.t);
  const c = useColors();
  const scheme = useResolvedTheme();
  // Read when a preview is built; the viewer page keeps the theme it opened with.
  const viewerColors: ViewerColors = { scheme, background: c.background, text: c.text, textMuted: c.textMuted, surface: c.surface };
  const colors = React.useRef(viewerColors);
  colors.current = viewerColors;
  const onCloseRef = React.useRef(opts.onClose);
  onCloseRef.current = opts.onClose;
  const [item, setItem] = React.useState<PreviewItem | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const source = React.useRef<PreviewSource | null>(null);
  const session = React.useRef<{ file: File; handedOff: boolean } | null>(null);
  // Bumped whenever a preview ends, so a download that finishes after its
  // preview was closed is dropped instead of reopening it.
  const seq = React.useRef(0);
  const busy = React.useRef(false);

  const end = React.useCallback(() => {
    seq.current += 1;
    const open = session.current;
    session.current = null;
    if (!open) return;
    closePdfPages(open.file.uri);
    if (!open.handedOff) discardPreviewFile(open.file);
  }, []);
  React.useEffect(() => end, [end]);

  /** Close without telling the owner (it closed the preview itself). */
  const reset = React.useCallback(() => {
    end();
    source.current = null;
    setItem(null);
    setLoading(false);
  }, [end]);

  const close = React.useCallback(() => {
    reset();
    onCloseRef.current?.();
  }, [reset]);

  /**
   * Show `src` in the preview, or hand it to another app when the preview
   * can't show it. The promise settles once that hand-off is done (and
   * rejects when it fails); a preview resolves at once.
   */
  const open = React.useCallback((src: PreviewSource): Promise<void> => {
    const kind = previewKindOf(src);
    if (kind === 'none') return handOff(src);
    end();
    source.current = src;
    const mine = seq.current;
    const current = () => mine === seq.current;
    setTitle(src.name);
    setItem(null);
    setLoading(true);
    void (async () => {
      try {
        const local = await materialize(src);
        if (!current()) {
          discardPreviewFile(local);
          return;
        }
        session.current = { file: local, handedOff: false };
        const next = await buildItem(kind, src, local, {
          tooLarge: t('files.preview_too_large', 'This file is too large to preview.'),
          pdfProtected: t(
            'email_viewer.preview.pdf_protected',
            'This PDF is password-protected. Open it in another app to enter the password.',
          ),
          pdfUnreadable: t('email_viewer.preview.pdf_unreadable', "This PDF can't be shown here."),
          zipProtected: t(
            'email_viewer.preview.archive_protected',
            'This archive is password-protected. Open it in another app to enter the password.',
          ),
          zipUnreadable: t('email_viewer.preview.archive_unreadable', "This archive can't be opened here."),
        }, colors.current);
        if (current()) setItem(next);
        // Closed while the PDF was opening: end() ran before the document was.
        else closePdfPages(local.uri);
      } catch (e) {
        if (!current()) return;
        close();
        Alert.alert(t('files.preview_error', 'Failed to load preview'), e instanceof Error ? e.message : String(e));
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return Promise.resolve();
  }, [end, close, t]);

  // The preview's own buttons, all on the downloaded copy.
  const act = React.useCallback((run: (local: File, src: PreviewSource) => Promise<void>, handsOff: boolean, failTitle: string) => {
    const open = session.current;
    const src = source.current;
    if (!open || !src || busy.current) return;
    busy.current = true;
    // Another app may keep reading the file after the sheet or viewer returns.
    if (handsOff) open.handedOff = true;
    run(open.file, src)
      .catch((e) => Alert.alert(failTitle, e instanceof Error ? e.message : String(e)))
      .finally(() => { busy.current = false; });
  }, []);

  const modalProps = React.useMemo(() => ({
    item,
    loading,
    title,
    onClose: close,
    onOpenExternal: () => act(
      (local, src) => shareLocalFile(local, src.type, src.name, { keep: true }),
      true,
      t('files.open_error', 'Could not open the file'),
    ),
    onShare: () => act(
      (local, src) => shareLocalFile(local, src.type, src.name, { forceSheet: true, keep: true }),
      true,
      t('files.share_file_error', 'Could not share the file'),
    ),
    onDownload: () => act(
      (local, src) => saveLocalFileCopy(local, src.type, src.saveName ?? src.name),
      false,
      t('files.download_error', 'Failed to download'),
    ),
  }), [item, loading, title, close, act, t]);

  return { open, close, reset, modalProps };
}
