import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Building } from '../icons';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyStore } from '../../stores/policy-store';
import { useInternalMailDomains } from '../../lib/avatar-internal-domains';
import { externalMailPolicyOf, externalSenders, type ExternalSender } from '../../lib/external-mail';

type FromList = readonly { email?: string | null }[] | null | undefined;

/**
 * The From addresses outside the organisation when the admin turned the
 * "External" label on (policy `organisation.externalMail.senderLabel`);
 * empty otherwise.
 */
export function useExternalSenders(from: FromList): ExternalSender[] {
  const organisation = usePolicyStore((s) => s.effective?.organisation);
  const senderLabel = React.useMemo(() => externalMailPolicyOf(organisation).senderLabel, [organisation]);
  const internal = useInternalMailDomains();
  return React.useMemo(() => (senderLabel ? externalSenders(from, internal) : []), [senderLabel, from, internal]);
}

/**
 * "External" next to the sender's name (webmail external-sender-chip.tsx).
 * A tap shows the line naming the domain (phones have no hover).
 */
export function ExternalSenderChip({ from }: { from: FromList }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const senders = useExternalSenders(from);
  const [open, setOpen] = React.useState(false);
  if (senders.length === 0) return null;
  const named = [...new Set(senders.map((s) => s.domain))].filter(Boolean).join(', ');
  const description = named
    ? t('external_mail.sender_tooltip', 'From {domain}, outside your organisation', { domain: named })
    : t('external_mail.sender_tooltip_no_domain', 'From an address without a domain, outside your organisation');
  const label = t('external_mail.sender_label', 'External');
  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.chip}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${description}`}
        accessibilityState={{ expanded: open }}
        testID="external-sender-chip"
      >
        <Building size={11} color={c.warning} />
        <Text style={styles.text}>{label}</Text>
      </Pressable>
      {open && <Text style={styles.detail} accessibilityLiveRegion="polite">{description}</Text>}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: { alignSelf: 'flex-start', marginTop: 4, maxWidth: '100%' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.warning,
      backgroundColor: c.warningBg,
    },
    text: { ...typography.small, fontWeight: '500', color: c.warning },
    detail: { ...typography.caption, color: c.textSecondary, marginTop: 2 },
  });
}
