import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { CloudOff, Send } from './icons';
import { useNetworkStore } from '../stores/network-store';
import { useOutboxStore } from '../stores/outbox-store';
import { useLocaleStore } from '../stores/locale-store';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { announceConnectivity } from '../lib/announce';
import { OutboxSheet } from './compose/OutboxSheet';
import { outboxHint } from '../lib/send-queue';

interface OfflineBannerProps {
  /** Optional extra notice (e.g. "Showing cached mail"). */
  hint?: string;
}

export function OfflineBanner({ hint }: OfflineBannerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const online = useNetworkStore((s) => s.online);
  const t = useLocaleStore((s) => s.t);
  // Pending offline mutations that will replay once we're back online.
  const queued = useOutboxStore((s) => s.entries.length);
  // Messages sent while offline (the Outbox). Counted outside the selector:
  // a selector must not build a new value on every call.
  const sends = useOutboxStore((s) => s.sends);
  const waitingSends = sends.filter((s) => s.status !== 'failed').length;
  const failedSends = sends.length - waitingSends;
  const [outboxOpen, setOutboxOpen] = React.useState(false);
  const offlineLabel = t('offline.banner', 'You are offline');
  // VoiceOver hears the drop too (Android reads the live region below).
  React.useEffect(() => {
    announceConnectivity(online, offlineLabel);
  }, [online, offlineLabel]);
  const sendsHint = outboxHint(waitingSends, failedSends, t);
  if (online && !sendsHint) return null;
  const queuedHint = !online && queued > 0
    ? t(
      'offline.queued_changes',
      '{count, plural, one {# change} other {# changes}} will sync when you reconnect',
      { count: queued },
    )
    : null;
  const label = online ? sendsHint! : offlineLabel;
  const suffix = [online ? null : hint, queuedHint, online ? null : sendsHint].filter(Boolean).join(' · ');
  const text = suffix ? `${label} — ${suffix}` : label;
  const sheet = <OutboxSheet visible={outboxOpen} onClose={() => setOutboxOpen(false)} />;
  if (sends.length > 0) {
    // With messages in the Outbox the bar opens it.
    return (
      <>
        <Pressable
          style={[styles.bar, online && styles.barOutbox]}
          onPress={() => setOutboxOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={text}
          accessibilityHint={t('outbox.open_hint', 'Opens the Outbox')}
          accessibilityLiveRegion="polite"
        >
          {online
            ? <Send size={14} color={failedSends > 0 ? c.error : c.textSecondary} />
            : <CloudOff size={14} color={c.warningForeground} />}
          <Text style={[styles.text, online && styles.textOutbox, online && failedSends > 0 && styles.textFailed]} numberOfLines={1}>
            {text}
          </Text>
        </Pressable>
        {sheet}
      </>
    );
  }
  return (
    <View style={styles.bar} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <CloudOff size={14} color={c.warningForeground} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: c.warning,
    },
    text: {
      ...typography.caption,
      color: c.warningForeground,
      flex: 1,
    },
    barOutbox: {
      backgroundColor: c.surfaceActive,
      minHeight: 32,
    },
    textOutbox: { color: c.text },
    textFailed: { color: c.error },
  });
}
