import React from 'react';
import { View, Text, StyleSheet, Modal, TextInput, type TextInputProps } from 'react-native';
import { AlertTriangle } from './icons';
import Button from './Button';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';
import { useSheetBottomInset } from '../lib/sheet-bottom-inset';

interface DialogInput {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  // Extra TextInput props (keyboardType, autoCapitalize, secureTextEntry…).
  props?: Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'style'>;
}

interface DialogProps {
  visible: boolean;
  title: string;
  message?: string;
  variant?: 'default' | 'destructive';
  confirmText?: string;
  cancelText?: string;
  // Turns the confirm dialog into a prompt (webmail prompt-dialog.tsx).
  input?: DialogInput;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Matches webmail confirm-dialog.tsx:
 * - backdrop: bg-black/50 backdrop-blur
 * - dialog: bg-background border border-border rounded-lg shadow-xl max-w-md
 * - icon badge (destructive): w-10 h-10 rounded-full bg-destructive/10
 * - title: text-lg font-semibold text-foreground
 * - message: text-sm text-muted-foreground
 * - footer: flex justify-end gap-3 px-6 pb-6
 */
export default function Dialog({
  visible,
  title,
  message,
  variant = 'default',
  confirmText,
  cancelText,
  input,
  confirmDisabled,
  onConfirm,
  onCancel,
}: DialogProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  // The card centres in the space above the keyboard (a prompt's field and
  // its confirm button stay visible) and above the navigation bar.
  const bottomInset = useSheetBottomInset(visible);
  const confirmLabel = confirmText ?? t('common.confirm', 'Confirm');
  const cancelLabel = cancelText ?? t('common.cancel', 'Cancel');
  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]}>
        <View style={styles.dialog}>
          <View style={styles.content}>
            {variant === 'destructive' && (
              <View style={styles.iconBadge}>
                <AlertTriangle size={20} color={c.error} />
              </View>
            )}
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {input ? (
              <TextInput
                value={input.value}
                onChangeText={input.onChangeText}
                placeholder={input.placeholder}
                placeholderTextColor={c.mutedForeground}
                autoFocus
                onSubmitEditing={confirmDisabled ? undefined : onConfirm}
                accessibilityLabel={input.placeholder ?? title}
                style={styles.input}
                {...input.props}
              />
            ) : null}
          </View>
          <View style={styles.footer}>
            <Button variant="outline" size="sm" onPress={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant={variant === 'destructive' ? 'destructive' : 'default'}
              size="sm"
              onPress={onConfirm}
              disabled={confirmDisabled}
            >
              {confirmLabel}
            </Button>
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
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  content: {
    padding: spacing.xxl,           // p-6
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: c.errorBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h3,               // text-lg font-semibold
    color: c.text,
  },
  message: {
    ...typography.body,             // text-sm
    color: c.mutedForeground,  // text-muted-foreground
    marginTop: spacing.sm,
  },
  // The shared Input look: 40 dp, transparent, radius 6.
  input: {
    ...typography.body,
    color: c.text,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
    minHeight: 40,
    marginTop: spacing.md,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,                // gap-3
    paddingHorizontal: spacing.xxl, // px-6
    paddingBottom: spacing.xxl,     // pb-6
  },
  });
}
