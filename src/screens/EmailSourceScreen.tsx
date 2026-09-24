import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Share2, Copy, Check } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fetchRawEmail, shareEmailEml } from '../lib/email-export';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailSource'>;

// A single <Text> holding a multi-megabyte string stalls the JS thread and
// the native text layout; anything past this is offered via share instead.
const MAX_DISPLAY_BYTES = 1024 * 1024;

export default function EmailSourceScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  // Blobs are account-scoped, so a message from a shared/group mailbox has
  // to be fetched against its owning account.
  const { blobId, subject, jmapAccountId } = route.params;
  const [raw, setRaw] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await fetchRawEmail(blobId, jmapAccountId);
        if (!cancelled) setRaw(text);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t('email_viewer.load_failed', 'Failed to load email source'));
      }
    })();
    return () => { cancelled = true; };
  }, [blobId, jmapAccountId, t]);

  const truncated = !!raw && raw.length > MAX_DISPLAY_BYTES;
  const shown = React.useMemo(() => (raw && truncated ? raw.slice(0, MAX_DISPLAY_BYTES) : raw), [raw, truncated]);

  const onShare = async () => {
    try {
      await shareEmailEml(blobId, undefined, subject, jmapAccountId);
    } catch (e) {
      Alert.alert(t('email_viewer.export_failed', 'Share failed'), e instanceof Error ? e.message : String(e));
    }
  };

  const onCopy = async () => {
    if (!raw) return;
    try {
      await Clipboard.setStringAsync(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      Alert.alert(t('common.error', 'Error'), e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {subject || t('email_viewer.email_source', 'Email Source')}
        </Text>
        <Pressable
          onPress={onCopy}
          style={styles.headerBtn}
          hitSlop={8}
          disabled={!raw}
          accessibilityLabel={t('email_viewer.copy_source', 'Copy to clipboard')}
        >
          {copied ? <Check size={20} color={c.success} /> : <Copy size={20} color={raw ? c.text : c.textMuted} />}
        </Pressable>
        <Pressable
          onPress={onShare}
          style={styles.headerBtn}
          hitSlop={8}
          disabled={!raw}
          accessibilityRole="button"
          accessibilityLabel={t('email_viewer.attachment_actions.share', 'Share')}
        >
          <Share2 size={20} color={raw ? c.text : c.textMuted} />
        </Pressable>
      </View>

      {!raw && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : error ? (
        <View style={styles.loading}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {truncated && (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                {t('email_viewer.source_too_large', 'The message is too large to display in full. Share the full source instead.')}
              </Text>
              <Pressable onPress={onShare} hitSlop={6}>
                <Text style={styles.noticeAction}>{t('email_viewer.export_email', 'Export as .eml')}</Text>
              </Pressable>
            </View>
          )}
          <Text selectable style={styles.source}>{shown}</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: componentSizes.headerHeight,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.sm,
  },
  headerBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
  },
  headerTitle: { ...typography.h3, color: c.text, flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { ...typography.body, color: c.error, paddingHorizontal: spacing.lg, textAlign: 'center' },
  body: { padding: spacing.lg },
  notice: {
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: c.warningBg,
    gap: spacing.xs,
  },
  noticeText: { ...typography.caption, color: c.warning },
  noticeAction: { ...typography.caption, color: c.primary, fontWeight: '600' },
  source: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: c.text,
  },
  });
}
