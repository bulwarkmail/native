import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  AlertTriangle, Eye, EyeOff, Bold, Italic, Underline, List as ListIcon,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import RichTextEditor, { type RichTextEditorHandle } from '../RichTextEditor';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useVacationStore } from '../../stores/vacation-store';
import { useManagedAccountStore } from '../../stores/managed-account-store';
import { useLocaleStore } from '../../stores/locale-store';
import { htmlToPlainText } from '../../lib/compose-html';
import { stripDangerousTags, escapeHtml } from '../../lib/email-html';
import {
  isValidLocalInput,
  localInputToUtcIso,
  normalizeUtcIso,
  parseLocalInput,
  utcIsoToLocalInput,
} from '../../lib/vacation-dates';

// Ported from the webmail's components/settings/vacation-settings.tsx. Dates
// are typed as local wall-clock time and sent as RFC 8621 UTCDate strings;
// the optional HTML body is edited in the composer's rich-text editor and
// sanitised on save, with the plain-text part derived from it when left blank.

export function VacationSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const store = useVacationStore();
  // Scoped to a shared/group account when Settings is managing one.
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);

  const [enabled, setEnabled] = useState(store.isEnabled);
  const [fromDate, setFromDate] = useState(utcIsoToLocalInput(store.fromDate));
  const [toDate, setToDate] = useState(utcIsoToLocalInput(store.toDate));
  const [subject, setSubject] = useState(store.subject);
  const [body, setBody] = useState(store.textBody);
  const [htmlEnabled, setHtmlEnabled] = useState(!!store.htmlBody);
  const [htmlBody, setHtmlBody] = useState(store.htmlBody || '');
  const [showPreview, setShowPreview] = useState(false);
  const editorRef = useRef<RichTextEditorHandle>(null);
  // Seed the editor once per load; RichTextEditor only reads initialHtml on mount.
  const [editorSeed, setEditorSeed] = useState(store.htmlBody || '');

  // The store reuses `error` for save failures too, so remember whether the
  // initial fetch itself failed (that's the only case that blanks the form).
  const [fetchError, setFetchError] = useState<string | null>(null);
  useEffect(() => {
    void store.fetch(managedAccountId ?? undefined)
      .then(() => setFetchError(useVacationStore.getState().error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedAccountId]);

  useEffect(() => {
    if (!store.hasLoaded) return;
    setEnabled(store.isEnabled);
    setFromDate(utcIsoToLocalInput(store.fromDate));
    setToDate(utcIsoToLocalInput(store.toDate));
    setSubject(store.subject);
    setBody(store.textBody);
    setHtmlEnabled(!!store.htmlBody);
    setHtmlBody(store.htmlBody || '');
    setEditorSeed(store.htmlBody || '');
  }, [
    store.hasLoaded, store.isEnabled, store.fromDate, store.toDate,
    store.subject, store.textBody, store.htmlBody,
  ]);

  const fromParsed = parseLocalInput(fromDate);
  const toParsed = parseLocalInput(toDate);
  const formatError = !isValidLocalInput(fromDate) || !isValidLocalInput(toDate);
  const endBeforeStart = !!(fromParsed && toParsed && toParsed <= fromParsed);
  const htmlText = htmlEnabled ? htmlToPlainText(htmlBody).trim() : '';
  const hasHtmlContent = htmlText.length > 0;
  const emptyBody = enabled && !body.trim() && !hasHtmlContent;
  const startInPast = useMemo(() => {
    if (!fromParsed) return false;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return fromParsed < todayStart;
  }, [fromParsed]);

  const warnings: string[] = [];
  if (endBeforeStart) warnings.push(t('settings.vacation.warnings.end_before_start', 'End date must be after start date'));
  if (startInPast) warnings.push(t('settings.vacation.warnings.start_in_past', 'Start date is in the past'));
  if (formatError) warnings.push(t('settings.vacation.warnings.date_format', 'Dates must be "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"'));
  if (emptyBody) warnings.push(t('settings.vacation.warnings.empty_body', 'Message body is empty - recipients will receive a blank reply'));

  // Mirrors the webmail's hasChanges: Save stays disabled until something
  // actually differs from what the server holds.
  const hasChanges =
    enabled !== store.isEnabled ||
    (formatError ? true : localInputToUtcIso(fromDate) !== normalizeUtcIso(store.fromDate)) ||
    (formatError ? true : localInputToUtcIso(toDate) !== normalizeUtcIso(store.toDate)) ||
    subject !== store.subject ||
    body !== store.textBody ||
    (htmlEnabled ? htmlBody : '') !== (store.htmlBody || '');

  const canSave = hasChanges && !endBeforeStart && !formatError && !store.isSaving;

  const handleSave = useCallback(async () => {
    // Read the live editor DOM rather than trusting onChange state (issue #9).
    let currentHtml = htmlBody;
    if (htmlEnabled && editorRef.current) {
      try {
        currentHtml = await editorRef.current.getHtml();
      } catch {
        // Bridge unavailable: fall back to the last onChange value.
      }
    }
    const sanitizedHtml =
      htmlEnabled && htmlToPlainText(currentHtml).trim()
        ? stripDangerousTags(currentHtml)
        : null;
    // Keep a plain-text part as the fallback for clients that don't render
    // HTML. If the user left it blank, derive it from the HTML body.
    const textBody = body.trim() || !sanitizedHtml ? body : htmlToPlainText(sanitizedHtml);

    try {
      await store.save({
        isEnabled: enabled,
        fromDate: localInputToUtcIso(fromDate),
        toDate: localInputToUtcIso(toDate),
        subject: subject.trim(),
        textBody,
        htmlBody: sanitizedHtml,
      });
      if (!sanitizedHtml) {
        setHtmlEnabled(false);
        setHtmlBody('');
      }
      Alert.alert(t('notifications.vacation_saved', 'Vacation responder settings saved'));
    } catch (err) {
      Alert.alert(
        t('notifications.vacation_save_failed', 'Failed to save vacation responder settings'),
        err instanceof Error ? err.message : undefined,
      );
    }
  }, [htmlBody, htmlEnabled, body, enabled, fromDate, toDate, subject, store, t]);

  const title = t('settings.vacation.title', 'Vacation Responder');
  const description = t('settings.vacation.description', "Automatically reply to incoming emails while you're away");

  if (store.isLoading && !store.hasLoaded) {
    return (
      <SettingsSection title={title} description={description}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={c.mutedForeground} />
          <Text style={styles.statusText}>{t('settings.vacation.loading', 'Loading vacation settings...')}</Text>
        </View>
      </SettingsSection>
    );
  }

  if (!store.isSupported && store.hasLoaded) {
    return (
      <SettingsSection title={title} description={description}>
        <View style={styles.unsupported}>
          <AlertTriangle size={16} color={c.warning} />
          <Text style={styles.unsupportedText}>
            {t('settings.vacation.not_supported', 'Your mail server does not support vacation responses.')}
          </Text>
        </View>
      </SettingsSection>
    );
  }

  if (fetchError) {
    return (
      <SettingsSection title={title} description={description}>
        <Text style={[styles.statusText, { color: c.error }]}>
          {t('settings.vacation.fetch_error', 'Failed to load vacation settings. Please try again.')}
        </Text>
        <Text style={styles.statusText}>{fetchError}</Text>
      </SettingsSection>
    );
  }

  const showHtmlPreview = htmlEnabled && hasHtmlContent;
  const previewHtml = showHtmlPreview ? buildPreviewHtml(stripDangerousTags(htmlBody), c) : '';

  return (
    <View style={styles.container}>
      <SettingsSection title={title} description={description}>
        <SettingItem
          label={t('settings.vacation.status.label', 'Vacation Responder')}
          description={t('settings.vacation.status.description', 'Send an automatic reply to people who email you')}
        >
          <View style={styles.statusRow}>
            <View style={[styles.pill, enabled ? styles.pillActive : styles.pillInactive]}>
              <Text style={[styles.pillText, enabled ? styles.pillTextActive : styles.pillTextInactive]}>
                {enabled
                  ? t('settings.vacation.status.active', 'Active')
                  : t('settings.vacation.status.inactive', 'Inactive')}
              </Text>
            </View>
            <ToggleSwitch checked={enabled} onChange={setEnabled} />
          </View>
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title={t('settings.vacation.date_range.title', 'Date Range')}
        description={t('settings.vacation.date_range.description', 'Optionally limit the auto-reply to a specific period')}
      >
        <SettingItem
          label={t('settings.vacation.date_range.start', 'Start Date')}
          description={t('settings.vacation.date_range.start_description', 'Leave empty for no start limit')}
        >
          <TextInput
            value={fromDate}
            onChangeText={setFromDate}
            placeholder="YYYY-MM-DD HH:MM"
            placeholderTextColor={c.mutedForeground}
            style={[styles.dateInput, !isValidLocalInput(fromDate) && styles.inputInvalid]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.vacation.date_range.end', 'End Date')}
          description={t('settings.vacation.date_range.end_description', 'Leave empty for no end limit')}
        >
          <TextInput
            value={toDate}
            onChangeText={setToDate}
            placeholder="YYYY-MM-DD HH:MM"
            placeholderTextColor={c.mutedForeground}
            style={[styles.dateInput, !isValidLocalInput(toDate) && styles.inputInvalid]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title={t('settings.vacation.message.title', 'Auto-Reply Message')}
        description={t('settings.vacation.message.description', 'The message that will be sent as a reply')}
      >
        <SettingItem
          label={t('settings.vacation.message.subject_label', 'Subject')}
          description={t('settings.vacation.message.subject_description', 'Subject line of the auto-reply')}
        >
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder={t('settings.vacation.message.subject_placeholder', 'Out of Office')}
            placeholderTextColor={c.mutedForeground}
            style={styles.subjectInput}
          />
        </SettingItem>
        <View style={styles.bodyBlock}>
          <Text style={styles.bodyLabel}>{t('settings.vacation.message.body_label', 'Message Body')}</Text>
          <Text style={styles.bodyDesc}>{t('settings.vacation.message.body_description', 'Plain text message content')}</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder={t('settings.vacation.message.body_placeholder', 'Thank you for your email. I am currently out of the office and will respond when I return.')}
            placeholderTextColor={c.mutedForeground}
            style={styles.bodyInput}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
          />
        </View>
        <SettingItem
          label={t('settings.vacation.message.html_label', 'Formatted message (HTML)')}
          description={t('settings.vacation.message.html_description', "Add a rich, formatted version with links and styling. Recipients whose mail client can't display it fall back to the plain text above.")}
          noBorder={!htmlEnabled}
        >
          <ToggleSwitch checked={htmlEnabled} onChange={setHtmlEnabled} />
        </SettingItem>
        {htmlEnabled && (
          <View style={styles.editorBlock}>
            <View style={styles.editorToolbar}>
              <ToolbarButton c={c} onPress={() => editorRef.current?.exec('bold')}><Bold size={16} color={c.text} /></ToolbarButton>
              <ToolbarButton c={c} onPress={() => editorRef.current?.exec('italic')}><Italic size={16} color={c.text} /></ToolbarButton>
              <ToolbarButton c={c} onPress={() => editorRef.current?.exec('underline')}><Underline size={16} color={c.text} /></ToolbarButton>
              <ToolbarButton c={c} onPress={() => editorRef.current?.exec('insertUnorderedList')}><ListIcon size={16} color={c.text} /></ToolbarButton>
            </View>
            <View style={styles.editorFrame}>
              <RichTextEditor
                key={editorSeed}
                ref={editorRef}
                initialHtml={editorSeed}
                placeholder={t('settings.vacation.message.html_placeholder', 'Write a formatted out-of-office reply…')}
                onChange={setHtmlBody}
              />
            </View>
          </View>
        )}
      </SettingsSection>

      {(body.trim().length > 0 || showHtmlPreview) && (
        <SettingsSection title={t('settings.vacation.preview.title', 'Preview')}>
          <Pressable style={styles.previewToggle} onPress={() => setShowPreview((v) => !v)}>
            {showPreview ? (
              <EyeOff size={14} color={c.primary} />
            ) : (
              <Eye size={14} color={c.primary} />
            )}
            <Text style={styles.previewToggleText}>
              {showPreview
                ? t('settings.vacation.preview.hide', 'Hide preview')
                : t('settings.vacation.preview.show', 'Show preview')}
            </Text>
          </Pressable>
          {showPreview && (
            <View style={styles.previewBox}>
              {subject.length > 0 && <Text style={styles.previewSubject}>{subject}</Text>}
              {showHtmlPreview ? (
                <WebView
                  originWhitelist={['about:blank']}
                  source={{ html: previewHtml }}
                  style={styles.previewWeb}
                  scrollEnabled={false}
                  javaScriptEnabled={false}
                  // Links in the preview must not navigate the WebView away.
                  onShouldStartLoadWithRequest={(req) => req.url === 'about:blank' || req.url.startsWith('data:')}
                />
              ) : (
                <Text style={styles.previewBody}>{body}</Text>
              )}
            </View>
          )}
        </SettingsSection>
      )}

      {warnings.length > 0 && (
        <View style={styles.warnings}>
          {warnings.map((w, i) => (
            <View key={i} style={styles.warnRow}>
              <AlertTriangle size={14} color={c.warning} />
              <Text style={styles.warnText}>{w}</Text>
            </View>
          ))}
        </View>
      )}

      {store.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{store.error}</Text>
        </View>
      )}

      <View style={styles.saveRow}>
        <Button onPress={() => void handleSave()} disabled={!canSave} loading={store.isSaving}>
          {store.isSaving
            ? t('settings.vacation.saving', 'Saving...')
            : t('settings.vacation.save', 'Save Changes')}
        </Button>
      </View>
    </View>
  );
}

function ToolbarButton({ c, onPress, children }: { c: ThemePalette; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 32, height: 32, borderRadius: radius.sm,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed ? c.muted : 'transparent',
      })}
    >
      {children}
    </Pressable>
  );
}

// Wrap the sanitised body so the preview follows the app palette. The
// content is already run through stripDangerousTags; the title is escaped
// because it's interpolated into markup here.
function buildPreviewHtml(inner: string, c: ThemePalette): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>body{margin:0;padding:0;font:14px -apple-system,Roboto,sans-serif;color:${escapeHtml(c.text)};background:${escapeHtml(c.background)}}a{color:${escapeHtml(c.primary)}}</style>`,
    '</head><body>',
    inner,
    '</body></html>',
  ].join('');
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xl },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  statusText: { ...typography.body, color: c.mutedForeground, paddingVertical: spacing.xs },
  unsupported: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: c.warningBg,
    borderRadius: radius.sm,
  },
  unsupportedText: { ...typography.body, color: c.warning, flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  pillActive: { backgroundColor: c.successBg },
  pillInactive: { backgroundColor: c.muted },
  pillText: { fontSize: 11, fontWeight: '500' },
  pillTextActive: { color: c.success },
  pillTextInactive: { color: c.mutedForeground },
  dateInput: {
    minWidth: 180,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: c.muted,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    ...typography.body,
  },
  inputInvalid: { borderColor: c.error },
  subjectInput: {
    width: 240,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: c.muted,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    ...typography.body,
  },
  bodyBlock: { paddingVertical: spacing.md },
  bodyLabel: { ...typography.bodyMedium, color: c.text },
  bodyDesc: { ...typography.caption, color: c.mutedForeground, marginTop: 2, marginBottom: spacing.sm },
  bodyInput: {
    width: '100%',
    minHeight: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: c.muted,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    ...typography.body,
  },
  editorBlock: { paddingBottom: spacing.md, gap: spacing.xs },
  editorToolbar: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  editorFrame: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    minHeight: 160,
  },
  previewToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewToggleText: { ...typography.body, color: c.primary },
  previewBox: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  previewSubject: { ...typography.bodyMedium, color: c.text, marginBottom: spacing.sm },
  previewBody: { ...typography.body, color: c.mutedForeground },
  previewWeb: { height: 200, backgroundColor: c.background },
  warnings: { gap: spacing.sm },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  warnText: { ...typography.body, color: c.warning, flex: 1 },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: c.errorBg,
  },
  errorText: { ...typography.body, color: c.error },
  saveRow: { alignItems: 'flex-end' },
});
}
