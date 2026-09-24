import React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import type { Email, EmailAddress, Identity } from '../../api/types';
import { spacing, radius, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import EmailBodyView from '../EmailBodyView';
import { CalendarInvitationBanner } from './CalendarInvitationBanner';
import { MessageHeader } from './MessageHeader';
import { AttachmentChips } from './AttachmentChips';
import { UnsubscribeBanner } from './UnsubscribeBanner';
import { ReadReceiptBanner } from './ReadReceiptBanner';
import { useBodyOverride } from './use-body-override';
import { deriveHeaderInfo } from '../../lib/email-headers';
import { calendarBannerShownFor } from '../../lib/attachment-display';

export interface MessageContentProps {
  email: Email;
  jmapAccountId?: string;
  identities: Identity[];
  currentMailboxRole?: string | null;
  /** On screen rather than pre-rendered by the pager (gates auto-sent read receipts). */
  active: boolean;
  themeOverride?: 'light' | 'dark' | null;
  onSwipe?: (direction: 'prev' | 'next') => void;
  onZoomChange?: (zoom: { pinching: boolean; zoomed: boolean }) => void;
  onToggleStar?: (email: Email) => void;
  onAddressPress: (address: EmailAddress) => void;
  /** Reflect a local keyword change (e.g. `$mdnsent`) in the caller's cache. */
  onEmailPatched: (email: Email) => void;
  /** Compact header (thread cards). */
  compact?: boolean;
  /**
   * Show a placeholder where the body goes: `email` is the list row, painted
   * while the message itself loads, or the page is off screen and its
   * WebView waits for the one on screen.
   */
  deferBody?: boolean;
  /** The body loaded and reported its height. */
  onBodySettled?: () => void;
  /**
   * Stretch to the space the parent leaves (a page showing one message), so
   * the body starts at the full page height instead of growing into it.
   */
  fill?: boolean;
}

/**
 * Everything below the subject for one message: header block with details,
 * receipt / unsubscribe banners, attachment chips, calendar invitation and
 * the body. Used both by the single-message pane and by expanded thread
 * cards.
 */
export function MessageContent({
  email, jmapAccountId, identities, currentMailboxRole, active, themeOverride, onSwipe, onZoomChange,
  onToggleStar, onAddressPress, onEmailPatched, compact, deferBody, onBodySettled, fill,
}: MessageContentProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const attachmentPosition = useSettingsStore((s) => s.attachmentPosition);
  const calendarParsing = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const headerInfo = React.useMemo(() => deriveHeaderInfo(email), [email]);
  const unwrap = useBodyOverride(email, jmapAccountId);
  const calendarBannerShown = calendarBannerShownFor(email, calendarParsing);
  const from = email.from?.[0];

  const chips = (
    <AttachmentChips
      email={email}
      jmapAccountId={jmapAccountId}
      calendarBannerShown={calendarBannerShown}
      tnefUnpacked={unwrap.tnefUnpacked}
      extracted={unwrap.extracted}
    />
  );

  return (
    <View style={fill ? styles.fill : undefined}>
      <View style={styles.headerBlock}>
        <MessageHeader
          email={email}
          identities={identities}
          headerInfo={headerInfo}
          onToggleStar={onToggleStar}
          onAddressPress={onAddressPress}
          compact={compact}
        />
        {attachmentPosition === 'beside-sender' && chips}
      </View>
      {attachmentPosition === 'below-header' && <View style={styles.chipsBlock}>{chips}</View>}

      {headerInfo.readReceiptRequestedBy && (
        <ReadReceiptBanner
          email={email}
          requestedBy={headerInfo.readReceiptRequestedBy}
          jmapAccountId={jmapAccountId}
          currentMailboxRole={currentMailboxRole}
          active={active}
          onHandled={onEmailPatched}
        />
      )}
      {headerInfo.list.listUnsubscribe?.preferred && (
        <UnsubscribeBanner
          email={email}
          list={headerInfo.list}
          messageKey={headerInfo.messageId ?? email.id}
          jmapAccountId={jmapAccountId}
        />
      )}

      <CalendarInvitationBanner email={email} jmapAccountId={jmapAccountId} />

      <View style={[styles.body, fill && styles.fill]}>
        {deferBody ? (
          <BodyPlaceholder styles={styles} fill={fill} />
        ) : unwrap.loading ? (
          <View style={styles.loading}><ActivityIndicator color={c.primary} /></View>
        ) : (
          <EmailBodyView
            email={email}
            senderEmail={from?.email}
            jmapAccountId={jmapAccountId}
            onSwipe={onSwipe}
            onZoomChange={onZoomChange}
            themeOverride={themeOverride}
            bodyOverride={unwrap.override}
            onSettled={onBodySettled}
            fill={fill}
          />
        )}
      </View>
    </View>
  );
}

const PLACEHOLDER_LINE_WIDTHS = ['92%', '100%', '85%', '96%', '60%', '88%', '74%', '40%'] as const;

// Static bones where the body will be: cheap enough for off-screen pages.
function BodyPlaceholder({ styles, fill }: { styles: ReturnType<typeof makeStyles>; fill?: boolean }) {
  return (
    <View style={[styles.placeholder, fill && styles.fill]}>
      {PLACEHOLDER_LINE_WIDTHS.map((w, i) => (
        <View key={i} style={[styles.placeholderLine, { width: w }]} />
      ))}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    headerBlock: {
      backgroundColor: c.background,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    chipsBlock: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    body: { backgroundColor: c.background },
    fill: { flexGrow: 1 },
    loading: { padding: spacing.xl, alignItems: 'center' },
    placeholder: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.sm },
    placeholderLine: { height: 12, borderRadius: radius.xs, backgroundColor: c.surfaceHover },
  });
}
