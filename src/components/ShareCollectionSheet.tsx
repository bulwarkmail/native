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
import { getPrincipals, ownPrincipalId } from '../api/files';
import type { Principal } from '../api/types';
import {
  detectPreset,
  presetOrder,
  presetRights,
  type RolePreset,
  type ShareKind,
  type ShareRights,
} from '../lib/share-presets';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';
import { useEmailStore } from '../stores/email-store';
import { jmapClient } from '../api/jmap-client';
import { clientServesAccount, clientServesActiveAccount } from '../lib/active-client-account';
import { principalsListUsable } from '../lib/share-principals';

// The webmail's sharing presets (same rights, same names).
const PRESET_LABEL_KEYS: Record<RolePreset, [string, string]> = {
  freeBusy: ['sharing.preset.freeBusy', 'Free/busy only'],
  read: ['sharing.preset.read', 'Read only'],
  readWrite: ['sharing.preset.readWrite', 'Read & write'],
  manager: ['sharing.preset.manager', 'Manager'],
};

/** The sheet's texts for `kind`; calendars keep the ones they always showed. */
function sheetStrings(kind: ShareKind, t: TranslateFn) {
  if (kind === 'calendar') {
    return {
      description: null,
      sharedWith: t('calendar.share.shared_with', 'Shared with'),
      addPeople: t('calendar.share.add_people', 'Add people'),
      searchPlaceholder: t('calendar.share.search_placeholder', 'Search by name or email'),
      noPrincipals: t('calendar.share.no_principals', 'Sharing is not available on this server.'),
      noMatches: t('calendar.share.no_matches', 'No matches'),
      failed: t('calendar.share.error', 'Failed to update sharing'),
    };
  }
  return {
    description: t('sharing.description', 'Grant access to other users or groups on this server. Changes take effect immediately.'),
    sharedWith: null,
    addPeople: t('sharing.add_person', 'Add person or group'),
    searchPlaceholder: t('sharing.search_placeholder', 'Search by name or email…'),
    noPrincipals: t('sharing.no_principals', 'No other users or groups found.'),
    noMatches: t('sharing.no_match', 'No matches.'),
    failed: t('sharing.share_failed', 'Failed to update sharing'),
  };
}

export interface ShareCollectionTarget<R> {
  id: string;
  name: string;
  shareWith?: Record<string, R> | null;
}

interface ShareCollectionSheetProps<K extends ShareKind> {
  kind: K;
  /** The collection to share; null keeps the sheet closed. */
  target: ShareCollectionTarget<ShareRights<K>> | null;
  /**
   * Grant (or, with null, revoke) a principal's access. `appAccountId`: the
   * app account shown when the sheet opened, which the change belongs to.
   */
  onShare: (
    id: string,
    principalId: string,
    rights: ShareRights<K> | null,
    appAccountId: string | null,
  ) => Promise<void>;
  onClose: () => void;
}

// JMAP sharing for an owned calendar or address book: pick a principal,
// choose a role. The principal list comes from the same Principal/query the
// Files share sheet uses.
export function ShareCollectionSheet<K extends ShareKind>({
  kind, target, onShare, onClose,
}: ShareCollectionSheetProps<K>) {
  type R = ShareRights<K>;
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const strings = sheetStrings(kind, t);
  const order = presetOrder(kind);

  const [principals, setPrincipals] = React.useState<Principal[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [shares, setShares] = React.useState<Record<string, R>>({});
  const [search, setSearch] = React.useState('');
  const [savingId, setSavingId] = React.useState<string | null>(null);
  // The app account shown when the sheet opened: the sheet may stay open
  // across a switch, and collection and principal ids repeat across accounts.
  const openedIn = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!target) return;
    const appAccountId = useEmailStore.getState().activeAccountId ?? null;
    openedIn.current = appAccountId;
    let current = true;
    setShares(target.shareWith ?? {});
    setSearch('');
    setPrincipals([]);
    // getPrincipals asks the live connection, which may still serve another
    // account during a switch, or be replaced before the list lands: either
    // way the list is another server's directory, so it is never shown.
    const opened = { appAccountId, gen: jmapClient.connectionGen };
    const usable = () => principalsListUsable(opened, {
      appAccountId: useEmailStore.getState().activeAccountId ?? null,
      gen: jmapClient.connectionGen,
      served: appAccountId ? clientServesAccount(appAccountId) : clientServesActiveAccount(),
    });
    if (!usable()) {
      setLoading(false);
      return () => { current = false; };
    }
    setLoading(true);
    getPrincipals()
      .then((list) => { if (current && usable()) setPrincipals(list); })
      .catch(() => { if (current && usable()) setPrincipals([]); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [target]);

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
    // The sheet is mounted with its screen, before a session may exist (an
    // offline cold start): nobody to list yet, and no own id to read.
    if (principals.length === 0) return [];
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

  const applyShare = async (principalId: string, rights: R | null) => {
    if (!target || savingId) return;
    setSavingId(principalId);
    try {
      await onShare(target.id, principalId, rights, openedIn.current);
      setShares((prev) => {
        const next = { ...prev };
        if (rights == null) delete next[principalId];
        else next[principalId] = rights;
        return next;
      });
    } catch (e) {
      Alert.alert(strings.failed, e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  if (!target) return null;

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
                  {t('sharing.title', 'Share "{name}"', { name: target.name })}
                </Text>
              </View>
              {strings.description ? (
                <Text style={styles.description}>{strings.description}</Text>
              ) : null}

              <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                {sharedEntries.length > 0 ? (
                  <View style={styles.section}>
                    {strings.sharedWith ? (
                      <Text style={styles.sectionLabel}>{strings.sharedWith}</Text>
                    ) : null}
                    {sharedEntries.map(([principalId, rights]) => {
                      const preset = detectPreset(kind, rights);
                      const busy = savingId === principalId;
                      return (
                        <View key={principalId} style={styles.shareRow}>
                          {renderPrincipalLabel(principalId)}
                          <View style={styles.roleChips}>
                            {order.map((p) => (
                              <Pressable
                                key={p}
                                onPress={() => void applyShare(principalId, presetRights(kind, p))}
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
                  <Text style={styles.sectionLabel}>{strings.addPeople}</Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder={strings.searchPlaceholder}
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  {loading ? (
                    <ActivityIndicator size="small" color={c.textMuted} style={{ marginTop: spacing.md }} />
                  ) : candidates.length === 0 ? (
                    <Text style={styles.empty}>
                      {principals.length === 0 ? strings.noPrincipals : strings.noMatches}
                    </Text>
                  ) : (
                    candidates.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => void applyShare(p.id, presetRights(kind, 'read'))}
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
    description: { ...typography.caption, color: c.textSecondary, marginBottom: spacing.md },
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
