import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Share2 } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fetchRawEmail, shareEmailEml } from '../lib/email-export';
import { colors, spacing, typography, componentSizes, radius } from '../theme/tokens';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailSource'>;

export default function EmailSourceScreen({ route, navigation }: Props) {
  const { blobId, subject } = route.params;
  const [raw, setRaw] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await fetchRawEmail(blobId);
        if (!cancelled) setRaw(text);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load email source');
      }
    })();
    return () => { cancelled = true; };
  }, [blobId]);

  const onShare = async () => {
    try {
      await shareEmailEml(blobId, subject);
    } catch (e) {
      Alert.alert('Share failed', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {subject || 'Email source'}
        </Text>
        <Pressable onPress={onShare} style={styles.headerBtn} hitSlop={8} disabled={!raw}>
          <Share2 size={20} color={raw ? colors.text : colors.textMuted} />
        </Pressable>
      </View>

      {!raw && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.loading}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text selectable style={styles.source}>{raw}</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: componentSizes.headerHeight,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  headerBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
  },
  headerTitle: { ...typography.h3, color: colors.text, flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { ...typography.body, color: colors.error, paddingHorizontal: spacing.lg, textAlign: 'center' },
  body: { padding: spacing.lg },
  source: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: colors.text,
  },
});
