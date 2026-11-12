import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, AlertTriangle, Info, X } from './icons';
import { useColors } from '../theme/colors';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountOrganisation } from '../lib/account-organisation';
import {
  announcementParts,
  nextAnnouncementChange,
  useAnnouncementDismissals,
  visibleAnnouncement,
} from '../lib/org-announcement';
import { openExternalUrl } from '../lib/open-url';

/** Timers longer than this are re-armed. */
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

const ICONS = { info: Info, warning: AlertTriangle, critical: AlertCircle } as const;

/** The time now, plus a re-render when the announcement starts or ends. */
function useClock(change: number | null): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (change === null) return undefined;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, change - Date.now()) + 50);
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [change, tick]);
  return Date.now();
}

/**
 * The admin's announcement (webmail components/org/org-announcement.tsx,
 * Organisation > Notices) under the header of Mail, Calendar, Contacts,
 * Files and Settings: per language, with its severity, start and end time
 * and an optional close that is remembered per account and announcement.
 * Plain text; links open through the app's link check.
 */
export function OrgAnnouncementBanner() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const accountId = useAuthStore((s) => s.activeAccountId);
  const announcement = useAccountOrganisation().announcement;
  const dismissed = useAnnouncementDismissals((s) => s.byAccount);
  const hydrated = useAnnouncementDismissals((s) => s.hydrated);
  const dismiss = useAnnouncementDismissals((s) => s.dismiss);
  React.useEffect(() => {
    if (!hydrated) void useAnnouncementDismissals.getState().hydrate();
  }, [hydrated]);

  const now = useClock(nextAnnouncementChange(announcement, Date.now()));
  const shown = hydrated ? visibleAnnouncement(announcement, { locale, now, accountId, dismissed }) : null;
  const parts = React.useMemo(() => announcementParts(shown?.text ?? ''), [shown?.text]);
  if (!shown) return null;

  const severity = shown.announcement.severity in ICONS ? shown.announcement.severity : 'info';
  const Icon = ICONS[severity];
  const tone = severity === 'critical'
    ? { bg: c.errorBg, fg: c.error, border: c.errorBorder }
    : severity === 'warning'
      ? { bg: c.warningBg, fg: c.warning, border: c.warning }
      : { bg: c.muted, fg: c.text, border: c.border };
  const severityLabel = severity === 'critical'
    ? t('org_notice.severity_critical', 'Important')
    : severity === 'warning'
      ? t('org_notice.severity_warning', 'Warning')
      : t('org_notice.severity_info', 'Information');

  return (
    <View
      style={[styles.row, { backgroundColor: tone.bg, borderColor: tone.border }]}
      accessibilityRole={severity === 'critical' ? 'alert' : 'summary'}
      accessibilityLabel={`${t('org_notice.label', 'Announcement')}. ${severityLabel}: ${shown.text}`}
      testID="org-announcement"
    >
      <Icon size={16} color={tone.fg} />
      <Text style={[styles.text, { color: tone.fg }]}>
        {parts.map((part, index) => part.kind === 'link' ? (
          <Text
            key={index}
            style={styles.link}
            accessibilityRole="link"
            onPress={() => { void openExternalUrl(part.href); }}
          >
            {part.href}
          </Text>
        ) : (
          <Text key={index}>{part.text}</Text>
        ))}
      </Text>
      {shown.announcement.dismissible && (
        <Pressable
          onPress={() => dismiss(shown.announcement, accountId)}
          hitSlop={10}
          style={styles.close}
          accessibilityRole="button"
          accessibilityLabel={t('org_notice.dismiss', 'Close announcement')}
          testID="org-announcement-dismiss"
        >
          <X size={16} color={tone.fg} />
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    text: { ...typography.caption, flex: 1, color: c.text },
    link: { fontWeight: '600', textDecorationLine: 'underline' },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginTop: -6, marginRight: -6 },
  });
}
