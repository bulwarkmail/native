import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import Button from './Button';
import { colors, spacing, radius, typography } from '../theme/tokens';

interface DialogProps {
  visible: boolean;
  title: string;
  message: string;
  variant?: 'default' | 'destructive';
  confirmText?: string;
  cancelText?: string;
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
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: DialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <View style={styles.content}>
            {variant === 'destructive' && (
              <View style={styles.iconBadge}>
                <AlertTriangle size={20} color={colors.error} />
              </View>
            )}
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.message}>{message}</Text>
          </View>
          <View style={styles.footer}>
            <Button variant="outline" size="sm" onPress={onCancel}>
              {cancelText}
            </Button>
            <Button variant={variant === 'destructive' ? 'destructive' : 'default'} size="sm" onPress={onConfirm}>
              {confirmText}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
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
    backgroundColor: colors.errorBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h3,               // text-lg font-semibold
    color: colors.text,
  },
  message: {
    ...typography.body,             // text-sm
    color: colors.mutedForeground,  // text-muted-foreground
    marginTop: spacing.sm,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,                // gap-3
    paddingHorizontal: spacing.xxl, // px-6
    paddingBottom: spacing.xxl,     // pb-6
  },
});
