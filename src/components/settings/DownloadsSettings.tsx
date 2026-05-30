import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { RotateCcw } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import Input from '../Input';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type SpaceReplacement } from '../../stores/settings-store';
import {
  emailExportFilename,
  attachmentDownloadFilename,
  buildSampleEmail,
  EMAIL_TOKENS,
  ATTACHMENT_TOKENS,
  DEFAULT_EMAIL_TEMPLATE,
  DEFAULT_ATTACHMENT_TEMPLATE,
  type EmailFilenameOptions,
} from '../../lib/download-filename';

const SAMPLE = buildSampleEmail();
const SAMPLE_ATTACHMENT = { name: 'Rechnung 2026.pdf', type: 'application/pdf' };

export function DownloadsSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const emailTemplate = useSettingsStore((s) => s.emailExportTemplate);
  const attachmentTemplate = useSettingsStore((s) => s.attachmentExportTemplate);
  const spaceReplacement = useSettingsStore((s) => s.exportSpaceReplacement);
  const lowercase = useSettingsStore((s) => s.exportLowercase);
  const stripDiacritics = useSettingsStore((s) => s.exportStripDiacritics);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const transforms: EmailFilenameOptions = { spaceReplacement, lowercase, stripDiacritics };
  const emailPreview = emailExportFilename(SAMPLE, { ...transforms, template: emailTemplate });
  const attachmentPreview = attachmentDownloadFilename(SAMPLE, SAMPLE_ATTACHMENT, {
    ...transforms,
    template: attachmentTemplate,
  });

  return (
    <View style={{ gap: spacing.xxxl }}>
      <SettingsSection
        title="Email Filename"
        description="Template used when exporting a message as an .eml file."
      >
        <Input
          value={emailTemplate}
          onChangeText={(v) => update('emailExportTemplate', v)}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          onPress={() => update('emailExportTemplate', DEFAULT_EMAIL_TEMPLATE)}
          style={styles.resetRow}
        >
          <RotateCcw size={12} color={c.mutedForeground} />
          <Text style={styles.resetText}>Reset to default</Text>
        </Pressable>
        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>Preview</Text>
          <Text style={styles.previewValue}>{emailPreview}</Text>
        </View>
        <TokenList tokens={EMAIL_TOKENS} styles={styles} />
      </SettingsSection>

      <SettingsSection
        title="Attachment Filename"
        description="Template used when saving or sharing an attachment."
      >
        <Input
          value={attachmentTemplate}
          onChangeText={(v) => update('attachmentExportTemplate', v)}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          onPress={() => update('attachmentExportTemplate', DEFAULT_ATTACHMENT_TEMPLATE)}
          style={styles.resetRow}
        >
          <RotateCcw size={12} color={c.mutedForeground} />
          <Text style={styles.resetText}>Reset to default</Text>
        </Pressable>
        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>Preview</Text>
          <Text style={styles.previewValue}>{attachmentPreview}</Text>
        </View>
        <TokenList tokens={ATTACHMENT_TOKENS} styles={styles} />
      </SettingsSection>

      <SettingsSection
        title="Filename Transform"
        description="Applied to every exported filename."
      >
        <View style={styles.group}>
          <SettingItem label="Spaces" description="Replace spaces in filenames." noBorder />
          <RadioGroup
            value={spaceReplacement}
            onChange={(v) => update('exportSpaceReplacement', v as SpaceReplacement)}
            options={[
              { value: 'keep', label: 'Keep' },
              { value: 'underscore', label: 'Underscore' },
              { value: 'dash', label: 'Dash' },
            ]}
          />
        </View>

        <SettingItem label="Lowercase" description="Force the whole filename to lowercase.">
          <ToggleSwitch checked={lowercase} onChange={(v) => update('exportLowercase', v)} />
        </SettingItem>

        <SettingItem
          label="Strip Accents"
          description="Convert accented letters to plain ASCII (ä → a)."
        >
          <ToggleSwitch checked={stripDiacritics} onChange={(v) => update('exportStripDiacritics', v)} />
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

function TokenList({
  tokens,
  styles,
}: {
  tokens: { token: string; description: string }[];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.tokenWrap}>
      {tokens.map((t) => (
        <View key={t.token} style={styles.tokenPill}>
          <Text style={styles.tokenText}>{`{${t.token}}`}</Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    group: { gap: spacing.sm },
    resetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: spacing.sm,
    },
    resetText: { ...typography.caption, color: c.mutedForeground },
    previewBox: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: c.muted,
      gap: 2,
    },
    previewLabel: { fontSize: 11, fontWeight: '600', color: c.mutedForeground, textTransform: 'uppercase' },
    previewValue: { ...typography.captionMedium, color: c.text },
    tokenWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.md },
    tokenPill: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.xs,
      backgroundColor: c.muted,
    },
    tokenText: { fontSize: 11, color: c.mutedForeground },
  });
}
