import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Trash2, UserPlus, Users } from 'lucide-react-native';
import { getPrincipals, ownPrincipalId } from '../../api/files';
import type { Calendar, CalendarRights, Principal } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

type RolePreset = 'freeBusy' | 'read' | 'readWrite' | 'manager';

// Same presets the webmail's share-collection dialog offers for calendars.
const CALENDAR_PRESETS: Record<RolePreset, CalendarRights> = {
  freeBusy: {
    mayReadFreeBusy: true, mayReadItems: false, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  read: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  readWrite: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: false,
  },
  manager: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
};

// The webmail's sharing presets (same rights, same names).
const PRESET_LABEL_KEYS: Record<RolePreset, [string, string]> = {
  freeBusy: ['sharing.preset.freeBusy', 'Free/busy only'],
  read: ['sharing.preset.read', 'Read only'],
  readWrite: ['sharing.preset.readWrite', 'Read & write'],
  manager: ['sharing.preset.manager', 'Manager'],
};

const PRESET_ORDER: RolePreset[] = ['freeBusy', 'read', 'readWrite', 'manager'];

function detectPreset(rights: CalendarRights): RolePreset | 'custom' {
  for (const preset of PRESET_ORDER) {
    const expected = CALENDAR_PRESETS[preset];
    const keys = Object.keys(expected) as (keyof CalendarRights)[];
    if (keys.every((k) => !!expected[k] === !!rights[k])) return preset;
  }
  return 'custom';
}

interface CalendarShareSheetProps {
  calendar: Calendar | null;
  onShare: (calendarId: string, principalId: string, rights: CalendarRights | null) => Promise<void>;
  onClose: () => void;
}

// JMAP sharing for an owned calendar: pick a principal, choose a role. The
// principal list comes from the same Principal/query the Files share sheet
// uses.
export function CalendarShareSheet({ calendar, onShare, onClose }: CalendarShareSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const [principals, setPrincipals] = React.useState<Principal[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [shares, setShares] = React.useState<Record<string, CalendarRights>>({});
  const [search, setSearch] = React.useState('');
  const [savingId, setSavingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!calendar) return;
    setShares(calendar.shareWith ?? {});
    setSearch('');
    setLoading(true);
    getPrincipals()
      .then(setPrincipals)
      .catch(() => setPrincipals([]))
      .finally(() => setLoading(false));
  }, [calendar]);

  const principalsById = React.useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of principals) map.set(p.id, p);
    return map;
  }, [principals]);

  const sharedEntries = React.useMemo(
    () => Object.entries(shares).filter(([, rights]) => rights != null),
    [shares],
  );

  const candidates = React.useMemo(() => {
    const self = ownPrincipalId();
    const q = search.trim().toLowerCase();
    return principals
      .filter((p) => p.id !== self && shares[p.id] == null)
      .filter((p) =>
        !q ||
        p.name?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q))
      .slice(0, 25);
  }, [principals, shares, search]);

  const applyShare = async (principalId: string, rights: CalendarRights | null) => {
    if (!calendar || savingId) return;
    setSavingId(principalId);
    try {
      await onShare(calendar.id, principalId, rights);
      setShares((prev) => {
        const next = { ...prev };
        if (rights == null) delete next[principalId];
        else next[principalId] = rights;
        return next;
      });
    } catch (e) {
      Alert.alert(
        t('calendar.share.error', 'Failed to update sharing'),
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSavingId(null);
    }
  };

  if (!calendar) return null;

  const renderPrincipalLabel = (principalId: string) => {
    const p = principalsById.get(principalId);
    return (
      <View style={styles.principalInfo}>
        <Text style={styles.principalName} numberOfLines={1}>
          {p?.description || p?.name || principalId}
        </Text>
        {p?.email ? (
          <Text style={styles.principalEmail} numberOfLines={1}>{p.email}</Text>
        ) : null}
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.titleRow}>
                <Users size={18} color={c.textMuted} />
                <Text style={styles.title} numberOfLines={1}>
                  {t('sharing.title', 'Share "{name}"', { name: calendar.name })}
                </Text>
              </View>

              <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                {sharedEntries.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('calendar.share.shared_with', 'Shared with')}</Text>
                    {sharedEntries.map(([principalId, rights]) => {
                      const preset = detectPreset(rights);
                      const busy = savingId === principalId;
                      return (
                        <View key={principalId} style={styles.shareRow}>
                          {renderPrincipalLabel(principalId)}
                          <View style={styles.roleChips}>
                            {PRESET_ORDER.map((p) => (
                              <Pressable
                                key={p}
                                onPress={() => void applyShare(principalId, CALENDAR_PRESETS[p])}
                                disabled={busy}
                                style={[styles.chip, preset === p && styles.chipActive]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: preset === p, disabled: busy }}
                              >
                                <Text style={[styles.chipText, preset === p && styles.chipTextActive]}>
                                  {t(PRESET_LABEL_KEYS[p][0], PRESET_LABEL_KEYS[p][1])}
                                </Text>
                              </Pressable>
                            ))}
                            {preset === 'custom' ? (
                              <Text style={styles.customLabel}>{t('sharing.preset.custom', 'Custom')}</Text>
                            ) : null}
                            <Pressable
                              onPress={() => void applyShare(principalId, null)}
                              disabled={busy}
                              hitSlop={8}
                              style={styles.removeBtn}
                              accessibilityRole="button"
                              accessibilityLabel={t('sharing.remove', 'Remove access')}
                            >
                              {busy ? (
                                <ActivityIndicator size="small" color={c.textMuted} />
                              ) : (
                                <Trash2 size={16} color={c.error} />
                              )}
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('calendar.share.add_people', 'Add people')}</Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('calendar.share.search_placeholder', 'Search by name or email')}
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  {loading ? (
                    <ActivityIndicator size="small" color={c.textMuted} style={{ marginTop: spacing.md }} />
                  ) : candidates.length === 0 ? (
                    <Text style={styles.empty}>
                      {principals.length === 0
                        ? t('calendar.share.no_principals', 'Sharing is not available on this server.')
                        : t('calendar.share.no_matches', 'No matches')}
                    </Text>
                  ) : (
                    candidates.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => void applyShare(p.id, CALENDAR_PRESETS.read)}
                        disabled={!!savingId}
                        style={({ pressed }) => [styles.candidateRow, pressed && styles.rowPressed]}
                      >
                        {renderPrincipalLabel(p.id)}
                        {savingId === p.id ? (
                          <ActivityIndicator size="small" color={c.textMuted} />
                        ) : (
                          <UserPlus size={18} color={c.primary} />
                        )}
                      </Pressable>
                    ))
                  )}
                </View>
              </ScrollView>

              <Pressable onPress={onClose} style={styles.doneBtn}>
                <Text style={styles.doneText}>{t('common.done', 'Done')}</Text>
              </Pressable>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      padding: spacing.lg,
      paddingBottom: spacing.xxl,
      maxHeight: '85%',
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
    title: { ...typography.h3, color: c.text, flex: 1 },
    scroll: { flexGrow: 0 },
    section: { marginBottom: spacing.lg, gap: spacing.sm },
    sectionLabel: { ...typography.captionMedium, color: c.textSecondary },
    shareRow: {
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    principalInfo: { flex: 1, minWidth: 0 },
    principalName: { ...typography.body, color: c.text },
    principalEmail: { ...typography.caption, color: c.textMuted },
    roleChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    chip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { ...typography.caption, color: c.text },
    chipTextActive: { color: c.primaryForeground },
    customLabel: { ...typography.caption, color: c.textMuted },
    removeBtn: { marginLeft: 'auto', padding: 4 },
    input: {
      minHeight: 40,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      color: c.text,
      backgroundColor: c.surface,
      ...typography.body,
    },
    empty: { ...typography.caption, color: c.textMuted, paddingVertical: spacing.sm },
    candidateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    doneBtn: { alignSelf: 'flex-end', paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
    doneText: { ...typography.bodyMedium, color: c.primary },
  });
}
