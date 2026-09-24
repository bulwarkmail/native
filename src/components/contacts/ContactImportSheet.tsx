import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { Upload, X, Check, FileText, AlertTriangle, BookUser } from 'lucide-react-native';
import type { ContactCard } from '../../api/types';
import { parseVCard, detectDuplicates } from '../../lib/vcard';
import { getContactDisplayName, getContactPrimaryEmail } from '../../lib/contact-utils';
import { useContactsStore } from '../../stores/contacts-store';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

// expo-document-picker is loaded lazily on first use; its native module is not
// linked into every build (matches the FilesScreen upload flow).
type DocumentPickerModule = typeof import('expo-document-picker');
let documentPickerModule: DocumentPickerModule | null = null;
function loadDocumentPicker(): DocumentPickerModule | null {
  if (documentPickerModule) return documentPickerModule;
  try {
    documentPickerModule = require('expo-document-picker') as DocumentPickerModule;
    return documentPickerModule;
  } catch {
    return null;
  }
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Address book the imported contacts are created in. */
  targetBookId: string | null;
  targetBookName?: string;
  onChangeTarget?: () => void;
  onImported?: (count: number) => void;
}

export default function ContactImportSheet({
  visible, onClose, targetBookId, targetBookName, onChangeTarget, onImported,
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const existing = useContactsStore((s) => s.contacts);
  const importContacts = useContactsStore((s) => s.importContacts);

  const [parsed, setParsed] = React.useState<ContactCard[]>([]);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [duplicates, setDuplicates] = React.useState<Map<number, string>>(new Map());
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [result, setResult] = React.useState<{ imported: number; failed: number } | null>(null);

  const slideY = React.useRef(new Animated.Value(900)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  const resetState = React.useCallback(() => {
    setParsed([]);
    setSelected(new Set());
    setDuplicates(new Map());
    setError(null);
    setImporting(false);
    setResult(null);
  }, []);

  React.useEffect(() => {
    if (visible) {
      resetState();
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 900, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity, resetState]);

  const pickFile = async () => {
    const picker = loadDocumentPicker();
    if (!picker) {
      Alert.alert(
        'Import unavailable',
        'The file picker is not installed in this build. Rebuild the app (expo run:android) to enable importing.',
      );
      return;
    }
    setError(null);
    let res;
    try {
      res = await picker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('contacts.import.picker_failed', 'Could not open the file picker'));
      return;
    }
    if (res.canceled || res.assets.length === 0) return;
    const asset = res.assets[0];

    if (asset.size && asset.size > 5 * 1024 * 1024) {
      setError(t('contacts.import.file_too_large', 'File is too large (max 5 MB)'));
      return;
    }

    try {
      const text = await FileSystem.readAsStringAsync(asset.uri);
      const contacts = parseVCard(text);
      if (contacts.length === 0) {
        setError(t('contacts.import.no_contacts', 'No contacts found in file'));
        return;
      }
      const dupes = detectDuplicates(existing, contacts);
      const initial = new Set<number>();
      contacts.forEach((_, idx) => { if (!dupes.has(idx)) initial.add(idx); });
      setParsed(contacts);
      setDuplicates(dupes);
      setSelected(initial);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('contacts.import.parse_error', 'Failed to parse vCard file'));
    }
  };

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(parsed.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  const doImport = async () => {
    if (!targetBookId) {
      Alert.alert(
        t('contacts.detail.no_address_book', 'No address book'),
        t('contacts.import.no_address_book', 'Create an address book before importing contacts.'),
      );
      return;
    }
    const toImport = parsed.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    setImporting(true);
    try {
      const outcome = await importContacts(toImport, targetBookId);
      setResult(outcome);
      onImported?.(outcome.imported);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('contacts.import.failed', 'Import failed'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('contacts.import.title', 'Import Contacts')}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.import.close', 'Close')}
            >
              <X size={20} color={c.text} />
            </Pressable>
          </View>

          {result !== null ? (
            <View style={styles.center}>
              <View style={styles.successBadge}>
                <Check size={26} color={c.primaryForeground} />
              </View>
              <Text style={styles.successText}>
                {t('contacts.import.success', '{count, plural, one {1 contact imported} other {# contacts imported}}', { count: result.imported })}
              </Text>
              {result.failed > 0 && (
                <Text style={[styles.successText, { color: c.error }]}>
                  {t(
                    'contacts.import.failed_count',
                    '{count, plural, one {# contact could not be imported.} other {# contacts could not be imported.}}',
                    { count: result.failed },
                  )}
                </Text>
              )}
              <Button variant="outline" size="sm" onPress={onClose}>{t('common.done', 'Done')}</Button>
            </View>
          ) : parsed.length === 0 ? (
            <View style={styles.center}>
              <Pressable style={styles.dropZone} onPress={() => { void pickFile(); }} accessibilityRole="button">
                <Upload size={32} color={c.textMuted} />
                <Text style={styles.dropTitle}>{t('contacts.import.choose_file_mobile', 'Choose a vCard file')}</Text>
                <Text style={styles.dropHint}>{t('contacts.import.file_types', '.vcf or .vcard files')}</Text>
              </Pressable>
              {!!error && (
                <View style={styles.errorBox}>
                  <AlertTriangle size={16} color={c.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
            </View>
          ) : (
            <>
              <Pressable
                style={styles.targetRow}
                onPress={onChangeTarget}
                disabled={!onChangeTarget}
                accessibilityRole={onChangeTarget ? 'button' : undefined}
              >
                <BookUser size={16} color={c.textSecondary} />
                <Text style={styles.targetText} numberOfLines={1}>
                  {targetBookName
                    ? t('contacts.import.into_named', 'Import into {name}', { name: targetBookName })
                    : t('contacts.import.into_address_book', 'Import into address book')}
                </Text>
                {onChangeTarget && <Text style={styles.targetChange}>{t('contacts.import.change_target', 'Change')}</Text>}
              </Pressable>

              <View style={styles.toolbar}>
                <Text style={styles.toolbarCount}>
                  {t('contacts.import.found', '{count, plural, one {1 contact found} other {# contacts found}}', { count: parsed.length })}
                  {' · '}
                  {t('contacts.import.selected', '{count, plural, one {1 selected} other {# selected}}', { count: selected.size })}
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.md }}>
                  <Pressable onPress={selectAll} hitSlop={6} accessibilityRole="button">
                    <Text style={styles.link}>{t('contacts.import.select_all', 'Select all')}</Text>
                  </Pressable>
                  <Pressable onPress={selectNone} hitSlop={6} accessibilityRole="button">
                    <Text style={styles.link}>{t('contacts.import.deselect_all', 'Deselect all')}</Text>
                  </Pressable>
                </View>
              </View>

              <ScrollView style={{ flex: 1 }}>
                {parsed.map((contact, idx) => {
                  const name = getContactDisplayName(contact);
                  const email = getContactPrimaryEmail(contact);
                  const isDupe = duplicates.has(idx);
                  const isSelected = selected.has(idx);
                  return (
                    <Pressable
                      key={idx}
                      onPress={() => toggle(idx)}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                    >
                      <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                        {isSelected && <Check size={13} color={c.primaryForeground} />}
                      </View>
                      <FileText size={16} color={c.textMuted} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.rowName} numberOfLines={1}>{name || email || '—'}</Text>
                        {!!email && !!name && (
                          <Text style={styles.rowEmail} numberOfLines={1}>{email}</Text>
                        )}
                      </View>
                      {isDupe && (
                        <Text style={styles.dupeBadge}>{t('contacts.import.duplicate', 'Duplicate')}</Text>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>

              {!!error && (
                <View style={styles.errorBox}>
                  <AlertTriangle size={16} color={c.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
                <Button variant="outline" onPress={onClose} disabled={importing}>{t('common.cancel', 'Cancel')}</Button>
                <Button
                  onPress={() => { void doImport(); }}
                  disabled={importing || selected.size === 0}
                  icon={importing ? <ActivityIndicator size="small" color={c.primaryForeground} /> : undefined}
                >
                  {importing
                    ? t('contacts.import.importing', 'Importing...')
                    : t('contacts.import.import_count', 'Import {count}', { count: selected.size })}
                </Button>
              </View>
            </>
          )}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '85%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.h3, color: c.text },
    close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
    dropZone: {
      width: '100%',
      borderWidth: 2,
      borderColor: c.border,
      borderStyle: 'dashed',
      borderRadius: radius.lg,
      paddingVertical: spacing.xxxl,
      alignItems: 'center',
      gap: spacing.sm,
    },
    dropTitle: { ...typography.bodyMedium, color: c.text },
    dropHint: { ...typography.caption, color: c.textMuted },
    successBadge: {
      width: 56, height: 56, borderRadius: radius.full,
      backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    successText: { ...typography.bodyMedium, color: c.text },
    targetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    targetText: { ...typography.caption, color: c.textSecondary, flex: 1 },
    targetChange: { ...typography.captionMedium, color: c.primary },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    toolbarCount: { ...typography.caption, color: c.textMuted },
    link: { ...typography.captionMedium, color: c.primary },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 48,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    checkbox: {
      width: 20, height: 20, borderRadius: radius.xs,
      borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: c.primary, borderColor: c.primary },
    rowName: { ...typography.body, color: c.text },
    rowEmail: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    dupeBadge: {
      ...typography.small,
      color: c.warning,
      backgroundColor: c.warningBg,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.xs,
      overflow: 'hidden',
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      backgroundColor: c.errorBg,
      borderWidth: 1,
      borderColor: c.errorBorder,
    },
    errorText: { ...typography.caption, color: c.errorForeground, flex: 1 },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  });
}
