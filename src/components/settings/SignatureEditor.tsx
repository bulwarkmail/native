import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Bold, Italic, Link2, List, ListOrdered, Underline } from '../icons';
import RichTextEditor, { type RichTextCommand, type RichTextEditorHandle } from '../RichTextEditor';
import Dialog from '../Dialog';
import { useColors } from '../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { linkPromptInput } from '../../lib/compose-link';
import { signatureEditorSeed, signatureFromHtml } from '../../lib/signature-edit';

export interface SignatureChange {
  htmlSignature?: string;
  textSignature?: string;
}

/**
 * One signature field (webmail components/identity/signature-editor.tsx).
 * With formatting it has a short toolbar and the composer's editor; the
 * plain-text version is made from it on every change. "Edit as HTML" swaps
 * in the HTML source. Someone who writes plain text only (Composing) gets a
 * plain text box, which leaves a stored HTML version alone.
 */
export function SignatureEditor({ html, text, plainOnly, label, onChange }: {
  html: string;
  text: string;
  plainOnly: boolean;
  /** The field's heading. */
  label: string;
  onChange: (change: SignatureChange) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const editorRef = React.useRef<RichTextEditorHandle>(null);
  const [source, setSource] = React.useState(false);
  // The editor reads its content once; a switch back from the source starts it again.
  const [seed, setSeed] = React.useState(() => ({ html: signatureEditorSeed(html, text), version: 0 }));
  const [linkValue, setLinkValue] = React.useState<string | null>(null);

  const editHtml = (value: string) => onChange(signatureFromHtml(value));

  if (plainOnly) {
    return (
      <View>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={text}
          onChangeText={(textSignature) => onChange({ textSignature })}
          multiline
          style={[styles.input, styles.box]}
        />
        <Text style={styles.hint}>
          {t('uxs_vacation.signature_plain_description', 'You write plain text only (Composing), so your signature is plain text too.')}
        </Text>
      </View>
    );
  }

  const tool = (command: RichTextCommand, label: string, icon: React.ReactNode) => (
    <Pressable
      key={command}
      onPress={() => editorRef.current?.exec(command)}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.tool}
    >
      {icon}
    </Pressable>
  );
  const iconColor = c.textSecondary;

  return (
    <View>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <Pressable
          onPress={() => {
            if (source) setSeed((prev) => ({ html: signatureEditorSeed(html, text), version: prev.version + 1 }));
            setSource((on) => !on);
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: source }}
          hitSlop={8}
        >
          <Text style={styles.toggle}>
            {source
              ? t('uxs_vacation.edit_formatted', 'Back to the formatting editor')
              : t('uxs_vacation.edit_as_html', 'Edit as HTML')}
          </Text>
        </Pressable>
      </View>
      {source ? (
        <TextInput
          accessibilityLabel={t('uxs_vacation.html_source_label', 'Signature as HTML')}
          value={html}
          onChangeText={editHtml}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.box, styles.mono]}
        />
      ) : (
        <View style={styles.editorBox}>
          <View style={styles.toolbar}>
            {tool('bold', t('email_composer.toolbar.bold', 'Bold'), <Bold size={16} color={iconColor} />)}
            {tool('italic', t('email_composer.toolbar.italic', 'Italic'), <Italic size={16} color={iconColor} />)}
            {tool('underline', t('email_composer.toolbar.underline', 'Underline'), <Underline size={16} color={iconColor} />)}
            {tool('insertUnorderedList', t('email_composer.toolbar.bullet_list', 'Bullet list'), <List size={16} color={iconColor} />)}
            {tool('insertOrderedList', t('email_composer.toolbar.ordered_list', 'Ordered list'), <ListOrdered size={16} color={iconColor} />)}
            <Pressable
              onPress={() => setLinkValue('https://')}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={t('email_composer.toolbar.insert_link', 'Insert link')}
              style={styles.tool}
            >
              <Link2 size={16} color={iconColor} />
            </Pressable>
          </View>
          <RichTextEditor
            key={seed.version}
            ref={editorRef}
            initialHtml={seed.html}
            onChange={editHtml}
          />
        </View>
      )}
      <Dialog
        visible={linkValue !== null}
        title={t('email_composer.toolbar.insert_link', 'Insert link')}
        confirmText={t('common.save', 'Save')}
        confirmDisabled={linkPromptInput(linkValue ?? '').error}
        input={{
          value: linkValue ?? '',
          onChangeText: setLinkValue,
          placeholder: t('email_composer.toolbar.link_address', 'Link address'),
          props: { keyboardType: 'url', autoCapitalize: 'none', autoCorrect: false },
        }}
        onConfirm={() => {
          const link = linkPromptInput(linkValue ?? '');
          setLinkValue(null);
          if (link.url) editorRef.current?.insertLink(link.url);
        }}
        onCancel={() => setLinkValue(null)}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    label: { ...typography.captionMedium, color: c.textSecondary, marginTop: spacing.md, marginBottom: spacing.xs },
    toggle: { ...typography.caption, color: c.primary, marginTop: spacing.md },
    input: {
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    box: { minHeight: 96, textAlignVertical: 'top' },
    mono: { fontFamily: 'monospace', fontSize: 12 },
    hint: { ...typography.caption, color: c.mutedForeground, marginTop: spacing.xs },
    editorBox: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, overflow: 'hidden', minHeight: 120 },
    toolbar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      padding: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    tool: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  });
}
