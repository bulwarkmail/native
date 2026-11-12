import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check } from '../icons';
import Button from '../Button';
import { useColors } from '../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import { SHOWN_PLACEHOLDERS, sendWarningsContent, type SendWarning } from '../../lib/compose-send-warnings';
import type { ExternalRecipient } from '../../lib/external-mail';

/**
 * One question before sending, whatever the composer found (webmail
 * send-warnings-dialog.tsx): a single warning keeps its own title and text,
 * several are listed with one "Send anyway".
 */
export function SendWarningsSheet({
  warnings, scheduling = false, onBack, onSendAnyway,
}: {
  /** What to ask about, in the order the composer checks it. Closed when null. */
  warnings: SendWarning[] | null;
  scheduling?: boolean;
  onBack: () => void;
  /** `dontAskAgain`: the box under a single warning that has a setting. */
  onSendAnyway: (dontAskAgain: boolean) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const visible = !!warnings && warnings.length > 0;
  const bottomInset = useSheetBottomInset(visible);
  const [dontAskAgain, setDontAskAgain] = React.useState(false);
  // A new question starts with the box unticked.
  React.useEffect(() => { setDontAskAgain(false); }, [warnings]);

  if (!visible) return null;
  const content = sendWarningsContent(warnings, t, scheduling);

  const chips = (matches: string[]) => (
    <View style={styles.chips} accessibilityLabel={t('email_composer.placeholder_warning.found', 'Placeholders found')}>
      {matches.slice(0, SHOWN_PLACEHOLDERS).map((p) => (
        <Text key={p} style={styles.chip} numberOfLines={1}>{p}</Text>
      ))}
      {matches.length > SHOWN_PLACEHOLDERS && (
        <Text style={styles.more}>
          {t('email_composer.placeholder_warning.more', 'and {count} more', { count: matches.length - SHOWN_PLACEHOLDERS })}
        </Text>
      )}
    </View>
  );

  // Who is outside the organisation, by field (webmail external-recipient-confirm.tsx).
  const fieldLabel = {
    to: t('external_mail.field_to', 'To'),
    cc: t('external_mail.field_cc', 'Cc'),
    bcc: t('external_mail.field_bcc', 'Bcc'),
  };
  const recipientList = (recipients: ExternalRecipient[]) => (
    <View style={styles.recipients} testID="send-warning-external-recipients">
      {recipients.map((r) => (
        <View key={r.address} style={styles.recipientRow}>
          <Text style={styles.recipientField}>{fieldLabel[r.field]}</Text>
          <Text style={styles.recipientAddress}>{r.address}</Text>
        </View>
      ))}
    </View>
  );

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="fade" onRequestClose={onBack}>
      <View style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <Text style={styles.title} accessibilityRole="header">{content.title}</Text>
            {content.description ? <Text style={styles.message}>{content.description}</Text> : null}
            {content.matches ? chips(content.matches) : null}
            {content.recipients ? recipientList(content.recipients) : null}
            {content.items.length > 0 && (
              <View style={styles.list}>
                {content.items.map((item) => (
                  <View key={item.kind} style={styles.item}>
                    <Text style={styles.bullet} importantForAccessibility="no">{'•'}</Text>
                    <View style={styles.itemBody}>
                      <Text style={styles.itemText}>{item.text}</Text>
                      {item.matches ? chips(item.matches) : null}
                      {item.recipients ? recipientList(item.recipients) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}
            {content.dontAskAgainLabel ? (
              <Pressable
                style={styles.checkRow}
                onPress={() => setDontAskAgain((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: dontAskAgain }}
                accessibilityLabel={content.dontAskAgainLabel}
              >
                <View style={[styles.box, dontAskAgain && styles.boxOn]}>
                  {dontAskAgain ? <Check size={14} color={c.primaryForeground} /> : null}
                </View>
                <Text style={styles.checkLabel}>{content.dontAskAgainLabel}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <View style={styles.footer}>
            <Button variant="outline" size="sm" onPress={onBack}>{content.backLabel}</Button>
            <Button size="sm" onPress={() => onSendAnyway(dontAskAgain)}>{content.sendLabel}</Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    dialog: {
      width: '100%',
      maxWidth: 400,
      maxHeight: '90%',
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      elevation: 10,
    },
    scroll: { flexGrow: 0 },
    content: { padding: spacing.xxl },
    title: { ...typography.h3, color: c.text },
    message: { ...typography.body, color: c.mutedForeground, marginTop: spacing.sm },
    list: { marginTop: spacing.md, gap: spacing.sm },
    item: { flexDirection: 'row', gap: spacing.sm },
    bullet: { ...typography.body, color: c.mutedForeground },
    itemBody: { flex: 1, minWidth: 0 },
    itemText: { ...typography.body, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm },
    chip: {
      ...typography.caption,
      fontFamily: 'monospace',
      color: c.text,
      backgroundColor: c.muted,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      maxWidth: '100%',
    },
    more: { ...typography.caption, color: c.mutedForeground },
    recipients: {
      marginTop: spacing.sm,
      gap: spacing.xs,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.muted,
      padding: spacing.sm,
    },
    recipientRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline' },
    recipientField: { ...typography.caption, color: c.mutedForeground, width: 32 },
    recipientAddress: { ...typography.body, color: c.text, flex: 1, flexShrink: 1 },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg, minHeight: 44 },
    box: {
      width: 20,
      height: 20,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxOn: { backgroundColor: c.primary, borderColor: c.primary },
    checkLabel: { ...typography.body, color: c.mutedForeground, flex: 1 },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: spacing.md,
      paddingHorizontal: spacing.xxl,
      paddingBottom: spacing.xxl,
    },
  });
}
