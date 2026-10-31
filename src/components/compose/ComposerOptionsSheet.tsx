import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check } from '../icons';
import ToggleSwitch from '../ToggleSwitch';
import { useColors } from '../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { MESSAGE_PRIORITIES, type MessagePriority } from '../../lib/message-priority';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import type { SecureMode } from '../../lib/crypto/secure-send';

export interface ComposerOptions {
  requestReadReceipt: boolean;
  requestDsn: boolean;
  requireTls: boolean;
  priority: MessagePriority;
  /** Sign / encrypt with OpenPGP or S/MIME (#58; the plugins' Options entries). */
  secureMode: SecureMode;
  sign: boolean;
  encrypt: boolean;
}

/** Which kinds of signing/encryption the From address has a key for. */
export interface SecureAvailability {
  pgp: boolean;
  smime: boolean;
}

/**
 * How many of the options differ from a plain message, for the badge on the
 * toolbar button (webmail composer options menu `activeCount`).
 */
export function activeComposerOptionCount(options: ComposerOptions): number {
  return [options.requestReadReceipt, options.requestDsn, options.requireTls, options.priority !== 'normal', options.sign, options.encrypt]
    .filter(Boolean).length;
}

/**
 * The composer's per-message options (webmail email-composer.tsx options
 * menu): read receipt, delivery status notification and REQUIRETLS - the
 * last two only when the account's submission extensions list them - the
 * message priority, and Sign / Encrypt with OpenPGP or S/MIME when the From
 * address has a key (the PGP and S/MIME plugins' Options entries).
 */
export function ComposerOptionsSheet({
  visible, options, dsnAvailable, requireTlsAvailable, secureAvailable, secureHint, onChange, onClose,
}: {
  visible: boolean;
  options: ComposerOptions;
  dsnAvailable: boolean;
  requireTlsAvailable: boolean;
  /** Own keys for the From address; the section is left out without any. */
  secureAvailable?: SecureAvailability;
  /** Why the chosen sign/encrypt can't go out yet (a recipient without a key). */
  secureHint?: string | null;
  onChange: (next: Partial<ComposerOptions>) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const bottomInset = useSheetBottomInset(visible);

  const toggleRow = (label: string, hint: string, value: boolean, key: 'requestReadReceipt' | 'requestDsn' | 'requireTls' | 'sign' | 'encrypt') => (
    <Pressable
      style={styles.row}
      onPress={() => onChange({ [key]: !value })}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value }}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <ToggleSwitch value={value} onValueChange={(v) => onChange({ [key]: v })} accessibilityLabel={label} />
    </Pressable>
  );

  return (
    <Modal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable accessible={false} style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]} onPress={onClose}>
        <Pressable accessible={false} style={styles.card} onPress={() => {}}>
          <Text style={styles.title} accessibilityRole="header">{t('email_composer.options', 'Options')}</Text>
          {toggleRow(
            t('email_composer.option_read_receipt', 'Request read receipt'),
            t('email_composer.option_read_receipt_hint', 'Ask the recipient to confirm they opened it'),
            options.requestReadReceipt,
            'requestReadReceipt',
          )}
          {dsnAvailable && toggleRow(
            t('email_composer.option_dsn', 'Delivery notification'),
            t('email_composer.option_dsn_hint', 'Get a report when the server delivers it'),
            options.requestDsn,
            'requestDsn',
          )}
          {requireTlsAvailable && toggleRow(
            t('email_composer.option_require_tls', 'Require encrypted delivery'),
            t('email_composer.option_require_tls_hint', 'Only deliver over TLS, otherwise bounce'),
            options.requireTls,
            'requireTls',
          )}
          {secureAvailable && (secureAvailable.pgp || secureAvailable.smime) && (
            <>
              <View style={styles.separator} />
              <Text style={styles.groupLabel}>{t('email_composer.option_security', 'Signature and encryption')}</Text>
              {secureAvailable.pgp && secureAvailable.smime && (
                <View style={styles.segment} accessibilityRole="radiogroup">
                  {(['pgp', 'smime'] as const).map((mode) => {
                    const selected = options.secureMode === mode;
                    const label = mode === 'pgp' ? 'OpenPGP' : 'S/MIME';
                    return (
                      <Pressable
                        key={mode}
                        style={[styles.segmentItem, selected && styles.segmentItemSelected]}
                        onPress={() => onChange({ secureMode: mode })}
                        accessibilityRole="radio"
                        accessibilityLabel={label}
                        accessibilityState={{ checked: selected, selected }}
                      >
                        <Text style={[styles.rowLabel, selected && styles.segmentTextSelected]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {toggleRow(
                t('email_composer.option_sign', 'Sign'),
                options.secureMode === 'pgp'
                  ? t('email_composer.option_sign_pgp_hint', 'Add an OpenPGP signature with your key')
                  : t('email_composer.option_sign_smime_hint', 'Add an S/MIME signature with your certificate'),
                options.sign,
                'sign',
              )}
              {toggleRow(
                t('email_composer.option_encrypt', 'Encrypt'),
                t('email_composer.option_encrypt_hint', 'Only the recipients (and you) can read it; every recipient needs a key'),
                options.encrypt,
                'encrypt',
              )}
              {!!secureHint && (options.sign || options.encrypt) && <Text style={styles.warning}>{secureHint}</Text>}
            </>
          )}
          <View style={styles.separator} />
          <Text style={styles.groupLabel}>{t('email_composer.option_priority', 'Priority')}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('email_composer.option_priority', 'Priority')}>
            {MESSAGE_PRIORITIES.map((level) => {
              const selected = options.priority === level;
              const label = level === 'high'
                ? t('email_composer.option_priority_high', 'High')
                : level === 'low'
                  ? t('email_composer.option_priority_low', 'Low')
                  : t('email_composer.option_priority_normal', 'Normal');
              return (
                <Pressable
                  key={level}
                  style={styles.row}
                  onPress={() => onChange({ priority: level })}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected, selected }}
                  testID={`composer-priority-${level}`}
                >
                  <Text style={[styles.rowLabel, styles.rowText]}>{label}</Text>
                  {selected && <Check size={18} color={c.primary} />}
                </Pressable>
              );
            })}
          </View>
          <Pressable style={styles.done} onPress={onClose} accessibilityRole="button">
            <Text style={styles.doneText}>{t('common.done', 'Done')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
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
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    title: { ...typography.h3, color: c.text, marginBottom: spacing.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 48,
      paddingVertical: spacing.xs,
    },
    rowText: { flex: 1 },
    rowLabel: { ...typography.body, color: c.text },
    rowHint: { ...typography.caption, color: c.textMuted },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.borderLight, marginVertical: spacing.xs },
    groupLabel: { ...typography.captionMedium, color: c.textSecondary },
    segment: { flexDirection: 'row', gap: spacing.xs, paddingVertical: spacing.xs },
    segmentItem: {
      flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border,
    },
    segmentItemSelected: { borderColor: c.primary, backgroundColor: c.primaryBg },
    segmentTextSelected: { color: c.primary },
    warning: { ...typography.caption, color: c.warning },
    done: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.xs },
    doneText: { ...typography.bodyMedium, color: c.primary },
  });
}
