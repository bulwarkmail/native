import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { Plus } from './icons';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';
import { keywordToken, useKeywordsStore, type KeywordDef } from '../stores/keywords-store';
import { checkNewTag, newTagDefinition } from '../lib/new-tag';

/**
 * "New tag" at the end of a tag picker: a name field; the tag gets the next
 * colour of the palette, is saved with the other tags and goes onto the
 * message(s) straight away (webmail components/email/tag-picker.tsx).
 */
export function NewTagRow({ keywords, onCreated }: {
  /** The tags the picker lists: a new id must not repeat one of them. */
  keywords: KeywordDef[];
  /** Apply the new tag's keyword token. */
  onCreated: (token: string) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const addKeyword = useKeywordsStore((s) => s.add);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const { error } = checkNewTag(name, keywords);
  const errorText = error === 'tag_exists'
    ? t('email_viewer.tag_exists', 'A tag with this name already exists')
    : error === 'tag_name_invalid' ? t('email_viewer.tag_name_invalid', 'Choose a shorter name') : null;

  const create = () => {
    const def = newTagDefinition(name, keywords);
    if (!def) return;
    addKeyword(def);
    setCreating(false);
    setName('');
    onCreated(keywordToken(def.id));
  };

  if (!creating) {
    return (
      <Pressable
        onPress={() => setCreating(true)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        testID="tag-picker-new"
      >
        <Plus size={16} color={c.textMuted} />
        <Text style={styles.label}>{t('email_viewer.new_tag', 'New tag')}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.form}>
      <TextInput
        autoFocus
        value={name}
        onChangeText={setName}
        onSubmitEditing={create}
        returnKeyType="done"
        placeholder={t('email_viewer.new_tag_placeholder', 'Tag name')}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t('email_viewer.new_tag_placeholder', 'Tag name')}
        style={[styles.input, errorText ? styles.inputError : null]}
      />
      {errorText && <Text style={styles.error} accessibilityRole="alert">{errorText}</Text>}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    label: { ...typography.body, color: c.textSecondary, flex: 1 },
    form: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
    input: {
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      minHeight: 40,
    },
    inputError: { borderColor: c.error },
    error: { ...typography.caption, color: c.error },
  });
}
