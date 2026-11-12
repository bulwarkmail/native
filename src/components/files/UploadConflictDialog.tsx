import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Button from '../Button';
import { Check } from '../icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import type { ConflictAnswer, UploadConflict, UploadConflictChoice } from '../../lib/files-upload-conflicts';

export interface UploadConflictQuestion {
  conflict: UploadConflict;
  /** How many conflicts are left, this one included. */
  remaining: number;
  answer: (answer: ConflictAnswer) => void;
}

/**
 * "<name> already exists." Replace, Keep both or Skip, and with more than
 * one conflict left, "Do this for all n conflicts" (webmail
 * components/files/upload-conflict-dialog.tsx). Cancel calls off the upload.
 */
export function UploadConflictDialog({ question }: { question: UploadConflictQuestion | null }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [applyToAll, setApplyToAll] = React.useState(false);
  // Each question starts unticked.
  React.useEffect(() => setApplyToAll(false), [question]);
  if (!question) return null;
  const { conflict, remaining, answer } = question;
  const choose = (choice: UploadConflictChoice) => answer({ choice, applyToAll: applyToAll && remaining > 1 });
  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="fade" onRequestClose={() => answer(null)}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityRole="alert">
          <Text style={styles.title} accessibilityRole="header">
            {t('ux_pim_files.conflict_title', '{name} already exists.', { name: conflict.name })}
          </Text>
          <Text style={styles.message}>
            {t('ux_pim_files.conflict_file_hint', 'Replace puts the new content into the existing file, so its shares stay. Keep both adds a copy with a number.')}
          </Text>
          {remaining > 1 ? (
            <Pressable
              onPress={() => setApplyToAll((v) => !v)}
              style={styles.checkRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: applyToAll }}
            >
              <View style={[styles.checkbox, applyToAll && styles.checkboxOn]}>
                {applyToAll ? <Check size={14} color={c.primaryForeground} /> : null}
              </View>
              <Text style={styles.checkText}>
                {t('ux_pim_files.apply_to_all', '{count, plural, other {Do this for all # conflicts}}', { count: remaining })}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.footer}>
            <Button size="sm" onPress={() => choose('replace')}>{t('ux_pim_files.replace', 'Replace')}</Button>
            <Button variant="outline" size="sm" onPress={() => choose('keep')}>{t('ux_pim_files.keep_both', 'Keep both')}</Button>
            <Button variant="outline" size="sm" onPress={() => choose('skip')}>{t('ux_pim_files.skip', 'Skip')}</Button>
            <Button variant="ghost" size="sm" onPress={() => answer(null)}>{t('common.cancel', 'Cancel')}</Button>
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
      padding: spacing.xxl,
      gap: spacing.md,
    },
    title: { ...typography.h3, color: c.text },
    message: { ...typography.body, color: c.mutedForeground },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
    checkbox: {
      width: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: c.primary, borderColor: c.primary },
    checkText: { ...typography.body, color: c.text, flex: 1 },
    footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm },
  });
}
