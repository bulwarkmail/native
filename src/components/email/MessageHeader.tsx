import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  Star, ChevronDown, ChevronUp, Reply, Forward, ShieldCheck, ShieldAlert, ShieldQuestion, Lock,
} from 'lucide-react-native';
import type { Email, EmailAddress, Identity } from '../../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import SenderAvatar from '../SenderAvatar';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useKeywordsStore, keywordToken } from '../../stores/keywords-store';
import { emailDisplayDate, formatHeaderDate, formatHeaderTime, formatFullDateTime } from '../../lib/email-date';
import {
  deriveHeaderInfo, deliveryDeltaMs, formatDelta, isAuthenticationSpoofed, findReceivingIdentity,
  type AuthenticationResults, type EmailHeaderInfo,
} from '../../lib/email-headers';
import { formatSize } from '../../lib/attachment-display';
import { isSmimeEmail } from '../../lib/smime';

interface Props {
  email: Email;
  identities: Identity[];
  headerInfo?: EmailHeaderInfo;
  onToggleStar?: (email: Email) => void;
  onAddressPress: (address: EmailAddress) => void;
  /** Compact variant for collapsed thread cards. */
  compact?: boolean;
}

function addressLabel(a: EmailAddress): string {
  return a.name || a.email;
}

function AddressList({
  label, addresses, onPress, styles,
}: { label: string; addresses: EmailAddress[] | undefined; onPress: (a: EmailAddress) => void; styles: ReturnType<typeof makeStyles> }) {
  if (!addresses || addresses.length === 0) return null;
  return (
    <Text style={styles.recipients} numberOfLines={2}>
      <Text style={styles.recipientsLabel}>{label} </Text>
      {addresses.map((a, i) => (
        <Text key={`${a.email}-${i}`} onPress={() => onPress(a)} style={styles.recipientLink}>
          {addressLabel(a)}{i < addresses.length - 1 ? ', ' : ''}
        </Text>
      ))}
    </Text>
  );
}

function authTone(result?: string): 'ok' | 'warn' | 'bad' | 'none' {
  switch (result) {
    case 'pass': return 'ok';
    case 'fail':
    case 'permerror': return 'bad';
    case 'softfail':
    case 'neutral':
    case 'temperror': return 'warn';
    default: return 'none';
  }
}

function AuthChip({ label, result, styles, c }: { label: string; result?: string; styles: ReturnType<typeof makeStyles>; c: ThemePalette }) {
  const t = useLocaleStore((s) => s.t);
  const tone = authTone(result);
  const color = tone === 'ok' ? c.success : tone === 'bad' ? c.error : tone === 'warn' ? c.warning : c.textMuted;
  const Icon = tone === 'ok' ? ShieldCheck : tone === 'bad' ? ShieldAlert : ShieldQuestion;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Icon size={12} color={color} />
      <Text style={[styles.chipText, { color }]}>
        {label} {result ? t(`email_viewer.authentication.result.${result}`, result) : '-'}
      </Text>
    </View>
  );
}

function DetailRow({ label, value, styles, mono }: { label: string; value?: string | null; styles: ReturnType<typeof makeStyles>; mono?: boolean }) {
  if (!value) return null;
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.detailMono]} selectable>{value}</Text>
    </View>
  );
}

/**
 * Sender / recipient / date block of a message, with the collapsible
 * "Show details" panel (recipients & routing, authentication, identifiers,
 * mailing list, properties) the webmail viewer shows.
 */
export function MessageHeader({ email, identities, headerInfo, onToggleStar, onAddressPress, compact }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const [showDetails, setShowDetails] = React.useState(false);
  React.useEffect(() => { setShowDetails(false); }, [email.id]);

  const info = React.useMemo(() => headerInfo ?? deriveHeaderInfo(email), [headerInfo, email]);
  const from = email.from?.[0];
  const starred = !!email.keywords?.$flagged;
  const displayDate = emailDisplayDate(email);
  const spoofed = isAuthenticationSpoofed(info.auth);

  // "via <identity>": the message was sent by one of the user's identities or
  // received at one of them (incl. +tag); hidden when the From can't be
  // trusted so a forged From doesn't get a legitimacy badge.
  const viaIdentity = React.useMemo(() => {
    if (spoofed || identities.length === 0) return null;
    const fromEmail = from?.email?.toLowerCase();
    const sentAs = fromEmail ? identities.find((i) => i.email?.toLowerCase() === fromEmail) : undefined;
    if (sentAs) return { identity: sentAs, direction: 'from' as const };
    const received = findReceivingIdentity(identities, email);
    if (received && identities.length > 1 && received.id !== identities[0].id) {
      return { identity: received, direction: 'to' as const };
    }
    return null;
  }, [spoofed, identities, from?.email, email]);

  const tags = React.useMemo(
    () => keywordDefs.filter((kw) => !!email.keywords?.[keywordToken(kw.id)]),
    [keywordDefs, email.keywords],
  );
  const important = !!email.keywords?.$important;
  const answered = !!email.keywords?.$answered;
  const forwarded = !!email.keywords?.$forwarded;
  const smime = React.useMemo(() => isSmimeEmail(email), [email]);
  const delta = deliveryDeltaMs(email);

  const auth: AuthenticationResults | undefined = info.auth;
  const hasAuth = !!(auth && (auth.spf || auth.dkim || auth.dmarc || auth.iprev));
  const attachmentsSummary = email.attachments?.length
    ? t('email_viewer.details.attachment_count_size', '{count, plural, one {# file} other {# files}} · {size}', {
      count: email.attachments.length,
      size: formatSize(email.attachments.reduce((n, a) => n + (a.size ?? 0), 0)),
    })
    : null;
  const receivedAt = formatFullDateTime(email.receivedAt, timeFormat, locale);

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <Pressable
          onPress={from ? () => onAddressPress(from) : undefined}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={from?.name || from?.email || t('email_viewer.unknown_sender', 'Unknown')}
        >
          <SenderAvatar name={from?.name} email={from?.email} size={compact ? componentSizes.avatarSm : componentSizes.avatarMd} />
        </Pressable>
        <View style={styles.info}>
          <Pressable onPress={from ? () => onAddressPress(from) : undefined}>
            <Text style={styles.name} numberOfLines={1}>
              {from?.name || from?.email || t('email_viewer.unknown_sender', 'Unknown')}
            </Text>
            {from?.name && from?.email ? (
              <Text style={styles.email} numberOfLines={1}>{from.email}</Text>
            ) : null}
          </Pressable>
          {!compact && (
            <>
              <AddressList label={t('email_viewer.to', 'To').toLowerCase()} addresses={email.to} onPress={onAddressPress} styles={styles} />
              <AddressList label={t('email_viewer.cc', 'CC').toLowerCase()} addresses={email.cc} onPress={onAddressPress} styles={styles} />
              <AddressList label={t('email_viewer.bcc', 'BCC').toLowerCase()} addresses={email.bcc} onPress={onAddressPress} styles={styles} />
              <AddressList label={t('email_viewer.reply_to_label', 'Reply-To:').replace(/:$/, '').toLowerCase()} addresses={email.replyTo} onPress={onAddressPress} styles={styles} />
            </>
          )}
        </View>
        <View style={styles.meta}>
          <Text style={styles.date}>{formatHeaderDate(displayDate, locale)}</Text>
          <Text style={styles.time}>
            {formatHeaderTime(displayDate, timeFormat, locale)}
            {!compact && email.size > 0 ? ` · ${formatSize(email.size)}` : ''}
          </Text>
          {onToggleStar && (
            <Pressable
              onPress={() => onToggleStar(email)}
              hitSlop={8}
              style={styles.star}
              accessibilityRole="button"
              accessibilityLabel={starred ? t('email_viewer.unstar', 'Unstar') : t('email_viewer.star', 'Star')}
            >
              <Star size={16} color={starred ? c.starred : c.textMuted} fill={starred ? c.starred : 'transparent'} />
            </Pressable>
          )}
        </View>
      </View>

      {(tags.length > 0 || important || answered || forwarded || viaIdentity || smime) && (
        <View style={styles.badges}>
          {important && (
            <View style={[styles.badge, { backgroundColor: c.warningBg }]}>
              <Text style={[styles.badgeText, { color: c.warning }]}>{t('email_viewer.important', 'Important')}</Text>
            </View>
          )}
          {tags.map((kw) => {
            const palette = c.tags[kw.color];
            return (
              <View key={kw.id} style={[styles.badge, { backgroundColor: palette.bg }]}>
                <View style={[styles.badgeDot, { backgroundColor: palette.dot }]} />
                <Text style={[styles.badgeText, { color: palette.text }]}>{kw.label}</Text>
              </View>
            );
          })}
          {answered && (
            <View style={styles.badge}>
              <Reply size={11} color={c.textMuted} />
              <Text style={styles.badgeText}>{t('email_viewer.replied', 'Replied')}</Text>
            </View>
          )}
          {forwarded && (
            <View style={styles.badge}>
              <Forward size={11} color={c.textMuted} />
              <Text style={styles.badgeText}>{t('email_viewer.forwarded', 'Forwarded')}</Text>
            </View>
          )}
          {viaIdentity && (
            <View style={[styles.badge, { backgroundColor: c.primaryBg }]}>
              <Text style={[styles.badgeText, { color: c.primary }]}>
                {viaIdentity.direction === 'from'
                  ? t('identities.badge.identity_short', 'via {name}', { name: viaIdentity.identity.email })
                  : t('email_viewer.received_via', 'to {name}', { name: viaIdentity.identity.email })}
              </Text>
            </View>
          )}
          {smime && (
            <View style={styles.badge}>
              <Lock size={11} color={c.textMuted} />
              <Text style={styles.badgeText}>{t('email_viewer.smime_unsupported', 'Signed/encrypted with S/MIME - not supported on mobile')}</Text>
            </View>
          )}
        </View>
      )}

      {!compact && (
        <Pressable onPress={() => setShowDetails((v) => !v)} style={styles.detailsToggle} hitSlop={6}>
          {showDetails ? <ChevronUp size={14} color={c.primary} /> : <ChevronDown size={14} color={c.primary} />}
          <Text style={styles.detailsToggleText}>
            {showDetails ? t('email_viewer.hide_details', 'Hide details') : t('email_viewer.show_details', 'Show details')}
          </Text>
        </Pressable>
      )}

      {showDetails && (
        <View style={styles.details}>
          <Text style={styles.detailsSection}>{t('email_viewer.details.recipients_routing', 'Recipients & routing')}</Text>
          <DetailRow label={t('email_viewer.from', 'From')} value={from ? `${from.name ? `${from.name} ` : ''}<${from.email}>` : undefined} styles={styles} />
          <DetailRow label={t('email_viewer.to', 'To')} value={email.to?.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')} styles={styles} />
          <DetailRow label={t('email_viewer.cc', 'CC')} value={email.cc?.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')} styles={styles} />
          <DetailRow label={t('email_viewer.bcc', 'BCC')} value={email.bcc?.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')} styles={styles} />
          <DetailRow label={t('email_viewer.details.sent', 'Sent')} value={formatFullDateTime(email.sentAt, timeFormat, locale)} styles={styles} />
          <DetailRow
            label={t('email_viewer.details.received', 'Received')}
            value={delta !== null && delta > 60000
              ? t('email_viewer.details.received_after_delay', '{date} · {delay} delivery time', { date: receivedAt, delay: formatDelta(delta) })
              : receivedAt}
            styles={styles}
          />

          {(hasAuth || info.spamScore || info.spamLLM) && (
            <>
              <Text style={styles.detailsSection}>{t('email_viewer.details.authentication_security', 'Authentication & security')}</Text>
              <View style={styles.chips}>
                {auth?.spf && <AuthChip label="SPF" result={auth.spf.result} styles={styles} c={c} />}
                {auth?.dkim && <AuthChip label="DKIM" result={auth.dkim.result} styles={styles} c={c} />}
                {auth?.dmarc && <AuthChip label="DMARC" result={auth.dmarc.result} styles={styles} c={c} />}
                {auth?.iprev && <AuthChip label={t('email_viewer.details.iprev', 'Reverse DNS')} result={auth.iprev.result} styles={styles} c={c} />}
              </View>
              {spoofed && (
                <Text style={[styles.detailValue, { color: c.error }]}>
                  {t('email_viewer.authentication.spoof_warning', 'The sender address could not be verified - this message may be spoofed.')}
                </Text>
              )}
              <DetailRow label={t('email_viewer.authentication.policy', 'Policy')} value={auth?.dmarc?.policy} styles={styles} />
              <DetailRow
                label={t('email_viewer.authentication.spam_score', 'Spam Score')}
                value={info.spamScore
                  ? t('email_viewer.details.spam_score_value', '{score} ({status})', { score: info.spamScore.score, status: info.spamScore.status })
                  : undefined}
                styles={styles}
              />
              <DetailRow
                label={t('email_viewer.details.ai_verdict', 'AI verdict')}
                value={info.spamLLM ? `${info.spamLLM.verdict} - ${info.spamLLM.explanation}` : undefined}
                styles={styles}
              />
            </>
          )}

          <Text style={styles.detailsSection}>{t('email_viewer.details.identifiers_threading', 'Identifiers & threading')}</Text>
          <DetailRow label={t('email_viewer.headers.message_id', 'Message ID')} value={info.messageId} styles={styles} mono />
          <DetailRow label={t('email_viewer.details.in_reply_to', 'In-Reply-To')} value={email.inReplyTo?.join(', ')} styles={styles} mono />
          <DetailRow label={t('email_viewer.details.references', 'References')} value={email.references?.length ? `${email.references.length}` : undefined} styles={styles} />
          <DetailRow label={t('email_viewer.details.thread_id', 'Thread ID')} value={email.threadId} styles={styles} mono />

          {(info.list.listId || info.list.listHelp || info.list.listPost || info.list.listUnsubscribe) && (
            <>
              <Text style={styles.detailsSection}>{t('email_viewer.details.mailing_list', 'Mailing list')}</Text>
              <DetailRow label={t('email_viewer.details.list_id', 'List ID')} value={info.list.listId} styles={styles} mono />
              <DetailRow label={t('email_viewer.details.list_help', 'List help')} value={info.list.listHelp} styles={styles} mono />
              <DetailRow label={t('email_viewer.details.list_post', 'List post')} value={info.list.listPost} styles={styles} mono />
              <DetailRow label={t('email_viewer.details.list_unsubscribe', 'Unsubscribe')} value={info.list.listUnsubscribe?.http ?? info.list.listUnsubscribe?.mailto} styles={styles} mono />
            </>
          )}

          <Text style={styles.detailsSection}>{t('email_viewer.details.message_properties', 'Message properties')}</Text>
          <DetailRow label={t('email_viewer.details.size', 'Size')} value={formatSize(email.size)} styles={styles} />
          <DetailRow label={t('email_viewer.details.mime_type', 'MIME type')} value={email.bodyStructure?.type} styles={styles} mono />
          <DetailRow label={t('email_viewer.attachments', 'Attachments')} value={attachmentsSummary} styles={styles} />
        </View>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: {
      backgroundColor: c.background,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.sm,
    },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    info: { flex: 1, minWidth: 0 },
    name: { ...typography.bodySemibold, color: c.text },
    email: { ...typography.caption, color: c.textSecondary, marginTop: 2 },
    recipients: { ...typography.caption, color: c.textSecondary, marginTop: 4 },
    recipientsLabel: { color: c.textMuted },
    recipientLink: { color: c.textSecondary },
    meta: { alignItems: 'flex-end', paddingTop: 1, gap: 2 },
    date: { ...typography.caption, color: c.textSecondary },
    time: { ...typography.caption, color: c.textMuted },
    star: { paddingTop: 4 },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.full,
      backgroundColor: c.surfaceHover,
    },
    badgeDot: { width: 8, height: 8, borderRadius: 4 },
    badgeText: { ...typography.small, color: c.textSecondary },
    detailsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
    detailsToggleText: { ...typography.caption, color: c.primary, fontWeight: '600' },
    details: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    detailsSection: { ...typography.small, color: c.textMuted, textTransform: 'uppercase', marginTop: spacing.xs, letterSpacing: 0.5 },
    detailRow: { flexDirection: 'row', gap: spacing.sm },
    detailLabel: { ...typography.caption, color: c.textMuted, width: 92 },
    detailValue: { ...typography.caption, color: c.text, flex: 1 },
    detailMono: { fontFamily: 'monospace', fontSize: 11 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.full,
      borderWidth: 1,
    },
    chipText: { ...typography.small },
  });
}
