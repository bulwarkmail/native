// Port of webmail components/email/structured-mail/card-parts.tsx at
// b0782af2d (same parts, React Native views). App differences: links open
// through the URL guard (lib/open-url), the reader's zone is the calendar
// zone setting, and <bdi> isolation is done with Unicode isolates.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ExternalLink, type AppIcon } from '../../icons';
import { resolveTimeZone } from '../../../lib/calendar-timezone';
import { openExternalUrl } from '../../../lib/open-url';
import { formatMoment, formatMomentTime, isOtherZone, isWebLink, type FormatOptions } from '../../../lib/structured-mail/format';
import type { Link, Moment, ReservationStatus } from '../../../lib/structured-mail/types';
import { useLocaleStore } from '../../../stores/locale-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useColors } from '../../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../../theme/tokens';

/** First strong isolate / left-to-right isolate / pop: what <bdi> and <bdi dir="ltr"> do. */
const FSI = String.fromCharCode(0x2068);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

/** Text that keeps its own direction inside a sentence in the other one (a <bdi>). */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}

/** Digits and codes that read left to right in a right-to-left UI (<bdi dir="ltr">). */
export function ltr(text: string): string {
  return `${LRI}${text}${PDI}`;
}

export function makeCardStyles(c: ThemePalette) {
  return StyleSheet.create({
    list: { gap: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.md },
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    badge: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.primaryBg,
    },
    badgeCancelled: { backgroundColor: c.errorBg },
    body: { flex: 1, minWidth: 0, gap: spacing.sm },
    eyebrow: { ...typography.small, color: c.textMuted, fontWeight: '600' },
    title: { ...typography.bodySemibold, color: c.text },
    titleCancelled: { color: c.textMuted, textDecorationLine: 'line-through' },
    pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
    details: { gap: 4 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 2 },
    metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    metaIcon: { marginTop: 3 },
    metaText: { flex: 1, minWidth: 0, ...typography.body, color: c.textSecondary },
    strong: { color: c.text },
    struck: { textDecorationLine: 'line-through' },
    hint: { ...typography.caption, color: c.textMuted },
    pill: { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
    pillText: { ...typography.small },
    action: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      maxWidth: '100%',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    actionPressed: { backgroundColor: c.surfaceHover },
    actionText: { ...typography.body, color: c.textSecondary },
    actionHost: { ...typography.body, color: c.textMuted, flexShrink: 1 },
    legs: { gap: spacing.sm },
    leg: { gap: 2 },
    legHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: 4 },
    legService: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
    legServiceText: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
    mono: { fontFamily: 'monospace' },
    images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 },
    image: { width: 40, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
    summary: { ...typography.body, color: c.textSecondary, paddingStart: 20 },
  });
}

export type CardStyles = ReturnType<typeof makeCardStyles>;

/** The palette and the card styles for it. */
export function useCardStyles(): { c: ThemePalette; styles: CardStyles } {
  const c = useColors();
  const styles = React.useMemo(() => makeCardStyles(c), [c]);
  return { c, styles };
}

/** Locale, clock and the reader's zone, for formatting a card's times. */
export function useCardFormat(): { opts: FormatOptions; readerZone: string } {
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeZone = useSettingsStore((s) => s.calendarTimeZone);
  return {
    opts: { locale, hour12: timeFormat === '12h' ? true : timeFormat === '24h' ? false : undefined },
    readerZone: resolveTimeZone(timeZone),
  };
}

/**
 * A time as the mail gave it, at the place, as nested text for a MetaRow.
 * `timeOnly` leaves out the date (an arrival on the departure day). Marked
 * "local time" when the place's clock differs from the reader's at that
 * instant.
 */
export function When({ at, timeOnly = false, struck = false }: { at: Moment; timeOnly?: boolean; struck?: boolean }) {
  const { styles } = useCardStyles();
  const { opts, readerZone } = useCardFormat();
  const text = timeOnly && at.time ? formatMomentTime(at, opts) : formatMoment(at, opts);
  const other = isOtherZone(at, readerZone);
  return (
    <>
      <Text style={[styles.strong, struck && styles.struck]}>{text}</Text>
      {other && <LocalTimeHint />}
    </>
  );
}

/** The "local time" mark after a time written at the place. */
export function LocalTimeHint() {
  const t = useLocaleStore((s) => s.t);
  const { styles } = useCardStyles();
  return (
    <Text
      style={styles.hint}
      testID="local-time-hint"
      accessibilityHint={t('email_viewer.structured_mail.local_time_title', 'Local time at the place, not your time zone')}
    >
      {' '}{t('email_viewer.structured_mail.local_time', 'local time')}
    </Text>
  );
}

/** One meta row: a small icon and text that wraps instead of overflowing. */
export function MetaRow({ icon: Icon, children, testID }: { icon: AppIcon; children: React.ReactNode; testID?: string }) {
  const { c, styles } = useCardStyles();
  return (
    <View style={styles.metaRow} testID={testID}>
      <Icon size={14} color={c.textSecondary} style={styles.metaIcon} />
      <Text style={styles.metaText}>{children}</Text>
    </View>
  );
}

/** A small rounded label in one of the status tones. */
export function Pill({ label, tone }: { label: string; tone: 'error' | 'warning' | 'success' | 'info' | 'muted' }) {
  const { c, styles } = useCardStyles();
  const colors = {
    error: { bg: c.errorBg, fg: c.error },
    warning: { bg: c.warningBg, fg: c.warning },
    success: { bg: c.successBg, fg: c.success },
    info: { bg: c.primaryBg, fg: c.info },
    muted: { bg: c.surfaceHover, fg: c.textSecondary },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: colors.bg }]} testID="structured-mail-pill">
      <Text style={[styles.pillText, { color: colors.fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** Cancelled, Pending or On hold; nothing for a confirmed booking. */
export function BookingStatusPill({ status }: { status?: ReservationStatus }) {
  const t = useLocaleStore((s) => s.t);
  if (!status || status === 'confirmed') return null;
  const label = status === 'cancelled'
    ? t('email_viewer.structured_mail.status_cancelled', 'Cancelled')
    : status === 'pending'
      ? t('email_viewer.structured_mail.status_pending', 'Pending')
      : t('email_viewer.structured_mail.status_hold', 'On hold');
  return <Pill label={label} tone={status === 'cancelled' ? 'error' : 'warning'} />;
}

/**
 * A link from the mail with its host beside the label ("Track · dhl.de").
 * Opens through the app's URL guard, which only hands http(s) to the OS.
 */
export function CardLink({ link, label, icon: Icon = ExternalLink }: { link?: Link; label: string; icon?: AppIcon }) {
  const { c, styles } = useCardStyles();
  if (!link || !isWebLink(link)) return null;
  return (
    <Pressable
      onPress={() => { void openExternalUrl(link.url); }}
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
      accessibilityRole="link"
      accessibilityLabel={`${label}, ${link.host}`}
      testID="structured-mail-link"
    >
      <Icon size={14} color={c.textSecondary} />
      <Text style={styles.actionText} numberOfLines={1}>{label}</Text>
      {/* The host is how a reader judges the link: wrapped, never cut off. */}
      <Text style={styles.actionHost}>· {link.host}</Text>
    </Pressable>
  );
}

interface CardShellProps {
  /** Accessible name of the card ("Flight booking"). */
  name: string;
  icon: AppIcon;
  /** Destructive tone and a struck-through title. */
  cancelled?: boolean;
  eyebrow: string;
  title: string;
  /** What screen readers hear instead of the title (a route written with arrows). */
  titleLabel?: string;
  pills?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  kind: string;
}

/** The banner layout every card shares (CalendarInvitationBanner's look). */
export function CardShell({ name, icon: Icon, cancelled = false, eyebrow, title, titleLabel, pills, children, actions, kind }: CardShellProps) {
  const { c, styles } = useCardStyles();
  return (
    <View style={styles.card} accessibilityLabel={name} testID={`structured-mail-card-${kind}`}>
      <View style={[styles.badge, cancelled && styles.badgeCancelled]} importantForAccessibility="no-hide-descendants">
        <Icon size={20} color={cancelled ? c.error : c.primary} />
      </View>
      <View style={styles.body}>
        <View>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text
            style={[styles.title, cancelled && styles.titleCancelled]}
            accessibilityRole="header"
            accessibilityLabel={titleLabel}
            testID="structured-mail-title"
          >
            {title}
          </Text>
        </View>
        {pills ? <View style={styles.pills}>{pills}</View> : null}
        {children ? <View style={styles.details}>{children}</View> : null}
        {actions ? <View style={styles.actions} testID="structured-mail-actions">{actions}</View> : null}
      </View>
    </View>
  );
}

/** "Flight · Lufthansa"; the kind alone when the provider is missing or already the title. */
export function eyebrowText(kind: string, provider: string | undefined, title: string): string {
  const p = provider?.trim();
  return p && p.toLowerCase() !== title.trim().toLowerCase() ? `${kind} · ${p}` : kind;
}
