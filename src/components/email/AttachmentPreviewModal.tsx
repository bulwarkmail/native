import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Image, ActivityIndicator, Platform, PixelRatio, Alert,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { X, ExternalLink, Share2, Download } from '../icons';
import type { Email } from '../../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import EmailBodyView from '../EmailBodyView';
import {
  handoffMimeType, needsNativeImageDecoder, needsWebImageViewer, type PreviewKind,
} from '../../lib/file-preview';
import { pdfPageFileName, renderPdfPage } from '../../lib/pdf-pages';
import type { ZipArchive } from '../../lib/zip-preview';
import { formatFullDateTime } from '../../lib/email-date';
import type { EmlPreview } from './use-body-override';
import { useFilePreview } from './use-file-preview';
import { ArchiveSummary, PreviewPartList, type PreviewPart } from './PreviewPartList';
import { SafeAreaModal } from '../SafeAreaModal';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';

export interface PreviewItem {
  kind: PreviewKind;
  name: string;
  mimeType: string;
  /** Local file:// URI of the downloaded copy (images, PDFs, media). */
  fileUri?: string;
  /** The viewer page next to the file (images, video, audio, Android's PDFs); see preview-viewer-html. */
  viewerUri?: string;
  /** Decoded text for text-like parts. */
  text?: string;
  /** The document for HTML and Markdown files, shown through the mail sanitiser. */
  html?: string;
  /** Parsed embedded message for .eml previews. */
  eml?: EmlPreview;
  /** A ZIP's directory, for archive previews. */
  archive?: ZipArchive;
  /** Replaces "No preview for this file type." on the fallback screen (e.g. the file is too large). */
  notice?: string;
}

interface Props {
  item: PreviewItem | null;
  loading: boolean;
  /** Header title while the item is still loading. */
  title?: string;
  onClose: () => void;
  /** Hand the file to another app (types without a preview, the header's Open button). */
  onOpenExternal: () => void;
  onShare: () => void;
  /** Save a copy; adds a Download button to the header. */
  onDownload?: () => void;
  /** Render in place (a split view's side pane) instead of a full-screen modal. */
  docked?: boolean;
}

interface ViewerWebViewProps {
  uri: string;
  background: string;
  onFailed: () => void;
  /** Messages other than 'error'. */
  onMessage?: (data: string) => void;
  webRef?: React.Ref<WebView>;
}

/**
 * A local page in a WebView that may read only its own folder: the image,
 * media and PDF viewers. It posts 'error' when the file doesn't decode.
 */
function ViewerWebView({ uri, background, onFailed, onMessage, webRef }: ViewerWebViewProps) {
  const folder = uri.slice(0, uri.lastIndexOf('/') + 1);
  const handleMessage = (e: WebViewMessageEvent) => {
    if (e.nativeEvent.data === 'error') onFailed();
    else onMessage?.(e.nativeEvent.data);
  };
  return (
    <WebView
      ref={webRef}
      source={{ uri }}
      originWhitelist={['file://*']}
      allowFileAccess
      allowingReadAccessToURL={folder}
      javaScriptEnabled
      domStorageEnabled={false}
      cacheEnabled={false}
      incognito
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      allowsFullscreenVideo
      allowsPictureInPictureMediaPlayback
      allowsAirPlayForMediaPlayback
      setSupportMultipleWindows={false}
      setBuiltInZoomControls
      setDisplayZoomControls={false}
      overScrollMode="never"
      bounces={false}
      onShouldStartLoadWithRequest={(req) => req.url === uri}
      onMessage={handleMessage}
      onError={onFailed}
      style={[viewerStyles.fill, { backgroundColor: background }]}
      containerStyle={{ backgroundColor: background }}
    />
  );
}

// Pages are rendered half again as wide as the screen's pixels, so text stays
// sharp at the first zoom step; PdfRenderer's bitmap is capped natively.
const PDF_PAGE_OVERSAMPLE = 1.5;

/**
 * Android's PDF view: the viewer page asks for each page as it comes near
 * the screen, and the page is rendered next to it by the platform's
 * PdfRenderer (pdf-pages.ts).
 */
function PdfPagesView({ fileUri, viewerUri, background, onFailed }: {
  fileUri: string;
  viewerUri: string;
  background: string;
  onFailed: () => void;
}) {
  const ref = React.useRef<WebView>(null);
  const { width } = useWindowDimensions();
  const pagePx = PixelRatio.getPixelSizeForLayoutSize(Math.min(width, 1000)) * PDF_PAGE_OVERSAMPLE;
  const folder = viewerUri.slice(0, viewerUri.lastIndexOf('/') + 1);
  const onMessage = (data: string) => {
    const m = /^page:(\d+)$/.exec(data);
    if (!m) return;
    const index = Number(m[1]);
    const name = pdfPageFileName(index);
    renderPdfPage(fileUri, index, pagePx, folder + name)
      .then(() => ref.current?.injectJavaScript(`window.__pdfPage(${index}, ${JSON.stringify(name)});true;`))
      .catch(() => undefined);
  };
  return <ViewerWebView webRef={ref} uri={viewerUri} background={background} onFailed={onFailed} onMessage={onMessage} />;
}

/**
 * In-app preview for images, PDFs (iOS's WebView shows them, Android renders the pages), video
 * and audio (the WebView's player), text, Markdown and HTML documents,
 * embedded messages and ZIP archives. The files inside an archive or a
 * message open in a preview of their own on top. Files that don't decode,
 * and types without a preview, offer another app instead. Used by every
 * place that opens a file.
 */
export function AttachmentPreviewModal({
  item, loading, title, onClose, onOpenExternal, onShare, onDownload, docked = false,
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const { width } = useWindowDimensions();
  // Files inside this one (archive entries, an .eml's attachments).
  const nested = useFilePreview();
  const { open: openNested } = nested;
  const openPart = React.useCallback(async (part: PreviewPart) => {
    try {
      const bytes = await part.read();
      await openNested({
        from: 'bytes',
        bytes,
        name: part.name,
        type: part.type || handoffMimeType(part.name, ''),
        size: bytes.byteLength,
      });
    } catch (e) {
      Alert.alert(t('email_viewer.attachment_failed', 'Could not open attachment'), e instanceof Error ? e.message : String(e));
    }
  }, [openNested, t]);
  const archive = item?.kind === 'archive' ? item.archive : undefined;
  const archiveParts = React.useMemo<PreviewPart[]>(() => {
    if (!archive) return [];
    return archive.entries.map((entry) => ({
      key: entry.path,
      name: entry.name,
      folder: entry.folder,
      size: entry.size,
      read: () => archive.read(entry.path),
    }));
  }, [archive]);
  const emlAttachments = item?.kind === 'eml' ? item.eml?.attachments : undefined;
  const emlParts = React.useMemo<PreviewPart[]>(() => (emlAttachments ?? []).map((att, i) => ({
    key: `${i}-${att.name}`,
    name: att.name,
    type: att.type,
    size: att.size,
    read: async () => att.bytes,
  })), [emlAttachments]);
  // Which viewers failed for the open file, keyed by its URI so the next one
  // starts clean: React Native's Image falls back to the WebView viewer, and
  // a WebView that can't decode the file falls back to another app.
  const [failed, setFailed] = React.useState<{ uri: string; native?: boolean; web?: boolean } | null>(null);
  const markFailed = React.useCallback((uri: string | undefined, which: 'native' | 'web') => {
    if (!uri) return;
    setFailed((prev) => ({ ...(prev?.uri === uri ? prev : {}), uri, [which]: true }));
  }, []);
  // The image fits the area it is shown in (a pane, a landscape window),
  // not a box derived from the window width that ran past the screen.
  const [imageArea, setImageArea] = React.useState<{ width: number; height: number } | null>(null);

  const docEmail = React.useMemo<Email | null>(() => {
    if (!item || (!item.eml && item.html == null)) return null;
    return {
      id: `file-preview-${item.kind}-${item.fileUri ?? item.name}`,
      threadId: '',
      mailboxIds: {},
      keywords: {},
      size: 0,
      receivedAt: item.eml?.date ?? new Date().toISOString(),
      hasAttachment: false,
      subject: item.eml?.subject ?? item.name,
    };
  }, [item]);

  const failure = item?.fileUri && failed?.uri === item.fileUri ? failed : null;
  // Android's WebView zooms; React Native's Image there doesn't. iOS zooms
  // the native image in its ScrollView. Each side's gaps go to the other.
  const imageInWeb = item?.kind === 'image' && !!item.viewerUri && !failure?.web && (
    failure?.native
    || (Platform.OS === 'android' ? !needsNativeImageDecoder(item) : needsWebImageViewer(item))
  );
  const imageFailed = item?.kind === 'image' && (
    !!failure?.web && (!!failure.native || !item.viewerUri || needsWebImageViewer(item))
    || (!!failure?.native && !item.viewerUri)
  );
  const mediaFailed = (item?.kind === 'video' || item?.kind === 'audio') && !!failure?.web;
  const pdfInline = item?.kind === 'pdf' && !!item.fileUri && (Platform.OS === 'ios' || !!item.viewerUri) && !failure?.web;
  // The fallback screen has its own Open button; the header adds one elsewhere.
  const showsFallback = !!item && (
    item.kind === 'none' || (item.kind === 'pdf' && !pdfInline) || imageFailed || mediaFailed
  );

  const renderFallback = (message: string) => (
    <View style={styles.centered}>
      <Text style={styles.hint}>{message}</Text>
      <Pressable style={styles.button} onPress={onOpenExternal}>
        <ExternalLink size={16} color={c.primaryForeground} />
        <Text style={styles.buttonText}>{t('email_viewer.preview.open_external', 'Open in app')}</Text>
      </Pressable>
    </View>
  );

  const renderDocument = (header?: React.ReactNode, footer?: React.ReactNode) => (
    <ScrollView style={styles.flex}>
      {header}
      {docEmail && <EmailBodyView email={docEmail} bodyOverride={{ html: item?.html ?? item?.eml?.html, text: item?.eml?.text }} />}
      {footer}
    </ScrollView>
  );

  const renderBody = () => {
    if (loading || !item) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={c.primary} />
        </View>
      );
    }
    switch (item.kind) {
      case 'image':
        if (imageFailed) {
          return renderFallback(t('email_viewer.preview.unsupported', 'No preview for this file type.'));
        }
        if (imageInWeb && item.viewerUri) {
          return (
            <ViewerWebView
              key={item.viewerUri}
              uri={item.viewerUri}
              background={c.background}
              onFailed={() => markFailed(item.fileUri, 'web')}
            />
          );
        }
        return (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.imageScroll}
            onLayout={(e) => {
              const { width: w, height: h } = e.nativeEvent.layout;
              setImageArea((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
            }}
            maximumZoomScale={4}
            minimumZoomScale={1}
            bouncesZoom
          >
            <Image
              source={{ uri: item.fileUri }}
              style={imageArea
                ? { width: imageArea.width - spacing.lg * 2, height: imageArea.height - spacing.lg * 2 }
                : { width: width - spacing.lg * 2, height: width * 1.2 }}
              resizeMode="contain"
              accessibilityLabel={item.name}
              onError={() => markFailed(item.fileUri, 'native')}
            />
          </ScrollView>
        );
      case 'video':
      case 'audio':
        if (mediaFailed || !item.viewerUri) {
          return renderFallback(t('email_viewer.preview.media_unsupported', "This file can't be played here."));
        }
        return (
          <ViewerWebView
            key={item.viewerUri}
            uri={item.viewerUri}
            background={item.kind === 'video' ? '#000' : c.background}
            onFailed={() => markFailed(item.fileUri, 'web')}
          />
        );
      case 'pdf':
        if (pdfInline && item.fileUri && item.viewerUri) {
          return (
            <PdfPagesView
              key={item.viewerUri}
              fileUri={item.fileUri}
              viewerUri={item.viewerUri}
              background={c.surface}
              onFailed={() => markFailed(item.fileUri, 'web')}
            />
          );
        }
        if (pdfInline && item.fileUri) {
          return (
            <WebView
              source={{ uri: item.fileUri }}
              originWhitelist={['file://*']}
              allowFileAccess
              allowingReadAccessToURL={item.fileUri}
              style={styles.flex}
              javaScriptEnabled={false}
              setSupportMultipleWindows={false}
              onShouldStartLoadWithRequest={(req) => req.url === item.fileUri}
            />
          );
        }
        return renderFallback(t('email_viewer.preview.pdf_unreadable', "This PDF can't be shown here."));
      case 'text':
        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.textScroll}>
            <Text selectable style={styles.text}>{item.text ?? ''}</Text>
          </ScrollView>
        );
      case 'html':
      case 'markdown':
        return renderDocument();
      case 'eml':
        return renderDocument(
          <View style={styles.emlHeader}>
            <Text style={styles.emlSubject}>{item.eml?.subject || t('email_viewer.no_subject', '(No Subject)')}</Text>
            {item.eml?.from ? <Text style={styles.emlMeta}>{item.eml.from}</Text> : null}
            {item.eml?.date ? <Text style={styles.emlMeta}>{formatFullDateTime(item.eml.date, timeFormat, locale) || item.eml.date}</Text> : null}
          </View>,
          emlParts.length > 0 ? (
            <PreviewPartList
              inline
              parts={emlParts}
              onOpen={openPart}
              header={<ArchiveSummary count={emlParts.length} truncated={false} />}
            />
          ) : null,
        );
      case 'archive':
        if (!item.archive) break;
        return (
          <PreviewPartList
            parts={archiveParts}
            onOpen={openPart}
            header={<ArchiveSummary count={archiveParts.length} truncated={item.archive.truncated} />}
          />
        );
      default:
        break;
    }
    return renderFallback(item.notice ?? t('email_viewer.preview.unsupported', 'No preview for this file type.'));
  };

  const content = (
      <SafeAreaView style={styles.container} edges={docked ? ['top', 'right'] : ['top', 'bottom', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Close')}
          >
            <X size={22} color={c.text} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>{item?.name ?? title ?? ''}</Text>
          {item && !showsFallback ? (
            <Pressable
              onPress={onOpenExternal}
              style={styles.headerBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('email_viewer.preview.open_external', 'Open in app')}
            >
              <ExternalLink size={20} color={c.text} />
            </Pressable>
          ) : null}
          {onDownload ? (
            <Pressable
              onPress={onDownload}
              style={styles.headerBtn}
              hitSlop={8}
              disabled={!item}
              accessibilityRole="button"
              accessibilityLabel={t('files.download', 'Download')}
            >
              <Download size={20} color={item ? c.text : c.textMuted} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={onShare}
            style={styles.headerBtn}
            hitSlop={8}
            disabled={!item}
            accessibilityRole="button"
            accessibilityLabel={t('email_viewer.attachment_actions.share', 'Share')}
          >
            <Share2 size={20} color={item ? c.text : c.textMuted} />
          </Pressable>
        </View>
        {renderBody()}
        {nested.modalProps.item || nested.modalProps.loading ? <AttachmentPreviewModal {...nested.modalProps} /> : null}
      </SafeAreaView>
  );
  if (docked) return item || loading ? content : null;
  return (
    <SafeAreaModal supportedOrientations={MODAL_ORIENTATIONS} visible={!!item || loading} animationType="slide" onRequestClose={onClose}>
      {content}
    </SafeAreaModal>
  );
}

const viewerStyles = StyleSheet.create({ fill: { flex: 1 } });

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    title: { ...typography.h3, color: c.text, flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
    hint: { ...typography.body, color: c.textMuted, textAlign: 'center' },
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: c.primary,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    buttonText: { ...typography.bodySemibold, color: c.primaryForeground },
    imageScroll: { alignItems: 'center', justifyContent: 'center', padding: spacing.lg, flexGrow: 1 },
    textScroll: { padding: spacing.lg },
    text: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18, color: c.text },
    emlHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: c.border, gap: 2 },
    emlSubject: { ...typography.bodySemibold, color: c.text },
    emlMeta: { ...typography.caption, color: c.textSecondary },
  });
}
