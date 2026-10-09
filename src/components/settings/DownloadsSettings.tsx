import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { RotateCcw } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import Input from '../Input';
import { spacing, radius, typography, fontPx, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type SpaceReplacement, type PostExportAction } from '../../stores/settings-store';
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
import { useLocaleStore } from '../../stores/locale-store';

const SAMPLE = buildSampleEmail();
const SAMPLE_ATTACHMENT = { name: 'Rechnung 2026.pdf', type: 'application/pdf' };

export function DownloadsSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const t = useLocaleStore((s) => s.t);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const emailTemplate = useSettingsStore((s) => s.emailExportTemplate);
  const attachmentTemplate = useSettingsStore((s) => s.attachmentExportTemplate);
  const spaceReplacement = useSettingsStore((s) => s.exportSpaceReplacement);
  const lowercase = useSettingsStore((s) => s.exportLowercase);
  const stripDiacritics = useSettingsStore((s) => s.exportStripDiacritics);
  const postExportAction = useSettingsStore((s) => s.postExportAction);

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
        title={t('settings.downloads.email_template.label', "Email (.eml) filename")}
        description={t('settings.downloads.email_template.description_mobile', "Template used when exporting a message as an .eml file.")}
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
          <Text style={styles.resetText}>{t('settings.downloads.reset', "Restore default")}</Text>
        </Pressable>
        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>{t('settings.downloads.preview', "Preview:")}</Text>
          <Text style={styles.previewValue}>{emailPreview}</Text>
        </View>
        <TokenList tokens={EMAIL_TOKENS} styles={styles} />
      </SettingsSection>

      <SettingsSection
        title={t('settings.downloads.attachment_template.label', "Attachment filename")}
        description={t('settings.downloads.attachment_template.description_mobile', "Template used when saving or sharing an attachment.")}
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
          <Text style={styles.resetText}>{t('settings.downloads.reset', "Restore default")}</Text>
        </Pressable>
        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>{t('settings.downloads.preview', "Preview:")}</Text>
          <Text style={styles.previewValue}>{attachmentPreview}</Text>
        </View>
        <TokenList tokens={ATTACHMENT_TOKENS} styles={styles} />
      </SettingsSection>

      <SettingsSection
        title={t('settings.downloads.transform_title', "Filename Transform")}
        description={t('settings.downloads.transform_description', "Applied to every exported filename.")}
      >
        <View style={styles.group}>
          <SettingItem label={t('settings.downloads.spaces.label', "Spaces")} description={t('settings.downloads.spaces.description', "Replace spaces in the resulting filename with another character.")} noBorder />
          <RadioGroup
            value={spaceReplacement}
            onChange={(v) => update('exportSpaceReplacement', v as SpaceReplacement)}
            options={[
              { value: 'keep', label: t('settings.downloads.spaces.keep', "Keep spaces") },
              { value: 'underscore', label: t('settings.downloads.spaces.underscore', "Replace with _") },
              { value: 'dash', label: t('settings.downloads.spaces.dash', "Replace with -") },
            ]}
          />
        </View>

        <SettingItem label={t('settings.downloads.lowercase.label', "Lowercase")} description={t('settings.downloads.lowercase.description', "Force the entire filename to lowercase.")}>
          <ToggleSwitch checked={lowercase} onChange={(v) => update('exportLowercase', v)} />
        </SettingItem>

        <SettingItem
          label={t('settings.downloads.strip_diacritics.label', "Strip diacritics")}
          description={t('settings.downloads.strip_diacritics.description_mobile', "Convert accented letters to plain ASCII (ä → a).")}
        >
          <ToggleSwitch checked={stripDiacritics} onChange={(v) => update('exportStripDiacritics', v)} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title={t('settings.downloads.after_export.label', "After export")}
        description={t('settings.downloads.after_export.description', "Optionally move the email after exporting it as .eml.")}
      >
        <View style={styles.group}>
          <RadioGroup
            value={postExportAction}
            onChange={(v) => update('postExportAction', v as PostExportAction)}
            options={[
              { value: 'keep', label: t('settings.downloads.after_export.keep', "Keep in mailbox") },
              { value: 'archive', label: t('settings.downloads.after_export.archive', "Move to archive") },
              { value: 'trash', label: t('settings.downloads.after_export.trash', "Move to trash") },
            ]}
          />
        </View>
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
    previewLabel: { fontSize: fontPx(11), fontWeight: '600', color: c.mutedForeground, textTransform: 'uppercase' },
    previewValue: { ...typography.captionMedium, color: c.text },
    tokenWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.md },
    tokenPill: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.xs,
      backgroundColor: c.muted,
    },
    tokenText: { fontSize: fontPx(11), color: c.mutedForeground },
  });
}
