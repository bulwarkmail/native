import React from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, ScrollView, Image, ActivityIndicator, Platform, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { X, ExternalLink, Share2, Download } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import EmailBodyView from '../EmailBodyView';
import type { PreviewKind } from '../../lib/attachment-display';
import type { EmlPreview } from './use-body-override';

export interface PreviewItem {
  kind: PreviewKind;
  name: string;
  mimeType: string;
  /** Local file:// URI for images and PDFs. */
  fileUri?: string;
  /** Decoded text for text-like parts. */
  text?: string;
  /** Parsed embedded message for .eml previews. */
  eml?: EmlPreview;
  /** Replaces "No preview for this file type." on the fallback screen (e.g. the file is too large). */
  notice?: string;
}

interface Props {
  item: PreviewItem | null;
  loading: boolean;
  /** Header title while the item is still loading. */
  title?: string;
  onClose: () => void;
  /** Hand the file to an external app (PDF on Android, unsupported types, the header's Open button). */
  onOpenExternal: () => void;
  onShare: () => void;
  /** Save a copy; adds a Download button to the header. */
  onDownload?: () => void;
}

/**
 * In-app preview for images, PDFs (iOS renders them in the WebView; Android
 * has no built-in PDF renderer, so it offers the external viewer), text and
 * embedded messages. Anything else goes to the external viewer / share sheet.
 * Used by the reader's attachment chips and the Files tab.
 */
export function AttachmentPreviewModal({
  item, loading, title, onClose, onOpenExternal, onShare, onDownload,
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const { width } = useWindowDimensions();
  // An image the platform can't decode would stay blank; fall back to the
  // external viewer instead. Keyed by URI so the next item starts clean.
  const [failedImageUri, setFailedImageUri] = React.useState<string | null>(null);

  const emlEmail = React.useMemo<Email | null>(() => {
    if (!item?.eml) return null;
    return {
      id: `eml-preview-${item.name}`,
      threadId: '',
      mailboxIds: {},
      keywords: {},
      size: 0,
      receivedAt: item.eml.date ?? new Date().toISOString(),
      hasAttachment: false,
      subject: item.eml.subject,
    };
  }, [item]);

  const imageFailed = item?.kind === 'image' && !!item.fileUri && failedImageUri === item.fileUri;
  const pdfInline = item?.kind === 'pdf' && Platform.OS === 'ios' && !!item.fileUri;
  // The fallback screen has its own Open button; the header adds one elsewhere.
  const showsFallback = !!item && (item.kind === 'none' || (item.kind === 'pdf' && !pdfInline) || imageFailed);

  const renderFallback = (message: string) => (
    <View style={styles.centered}>
      <Text style={styles.hint}>{message}</Text>
      <Pressable style={styles.button} onPress={onOpenExternal}>
        <ExternalLink size={16} color={c.primaryForeground} />
        <Text style={styles.buttonText}>{t('email_viewer.preview.open_external', 'Open in app')}</Text>
      </Pressable>
    </View>
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
        return (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.imageScroll}
            maximumZoomScale={4}
            minimumZoomScale={1}
            bouncesZoom
          >
            <Image
              source={{ uri: item.fileUri }}
              style={{ width: width - spacing.lg * 2, height: width * 1.2 }}
              resizeMode="contain"
              accessibilityLabel={item.name}
              onError={() => setFailedImageUri(item.fileUri ?? null)}
            />
          </ScrollView>
        );
      case 'pdf':
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
        return renderFallback(t('email_viewer.preview.pdf_external', 'PDFs open in your PDF viewer on this device.'));
      case 'text':
        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.textScroll}>
            <Text selectable style={styles.text}>{item.text ?? ''}</Text>
          </ScrollView>
        );
      case 'eml':
        return (
          <ScrollView style={styles.flex}>
            <View style={styles.emlHeader}>
              <Text style={styles.emlSubject}>{item.eml?.subject || t('email_viewer.no_subject', '(No Subject)')}</Text>
              {item.eml?.from ? <Text style={styles.emlMeta}>{item.eml.from}</Text> : null}
              {item.eml?.date ? <Text style={styles.emlMeta}>{item.eml.date}</Text> : null}
            </View>
            {emlEmail && (
              <EmailBodyView
                email={emlEmail}
                bodyOverride={{ html: item.eml?.html, text: item.eml?.text }}
              />
            )}
          </ScrollView>
        );
      default:
        return renderFallback(item.notice ?? t('email_viewer.preview.unsupported', 'No preview for this file type.'));
    }
  };

  return (
    <Modal visible={!!item || loading} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
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
      </SafeAreaView>
    </Modal>
  );
}

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
