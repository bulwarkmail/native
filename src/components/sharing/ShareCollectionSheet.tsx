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
import { Trash2, UserPlus, Users } from '../icons';
import { listPrincipals, ownPrincipalId, type PrincipalListing } from '../../api/files';
import { findPrincipalByEmail } from '../../api/delegation';
import type { Principal } from '../../api/types';
import { directoryNotice } from '../../lib/principal-directory';
import { canLookUpAddress, lookupMessage, lookupResult, type Lookup } from '../../lib/delegation/display';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { unknownPersonLabel } from './unknown-person';
import { useSheetInsets } from '../../lib/use-layout';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';

/** A role the sheet offers: its rights and the webmail's name for it. */
export interface SharePreset<R> {
  key: string;
  label: string;
  rights: R;
}

/** The preset whose rights `rights` match, or 'custom'. */
export function detectSharePreset<R extends object>(rights: R, presets: SharePreset<R>[]): string {
  for (const preset of presets) {
    const keys = Object.keys(preset.rights) as (keyof R)[];
    if (keys.every((k) => !!preset.rights[k] === !!rights[k])) return preset.key;
  }
  return 'custom';
}

/** The collection being shared: a calendar, an address book. */
export interface ShareableCollection<R> {
  id: string;
  name: string;
  shareWith?: Record<string, R> | null;
}

interface ShareCollectionSheetProps<R extends object> {
  /** Null hides the sheet. */
  collection: ShareableCollection<R> | null;
  presets: SharePreset<R>[];
  /** What a new share gets (the webmail: read). */
  addRights: R;
  onShare: (collectionId: string, principalId: string, rights: R | null) => Promise<void>;
  onClose: () => void;
  /**
   * Names the preset a stored grant amounts to, when the server stores
   * something other than what was sent (a folder on Stalwart 1.0).
   */
  detectPreset?: (rights: R) => string;
}

// JMAP sharing for an owned collection: pick a principal, choose a role
// (webmail ShareCollectionDialog). The principal list comes from the same
// Principal/query the Files share sheet uses.
export function ShareCollectionSheet<R extends object>({
  collection, presets, addRights, onShare, onClose, detectPreset,
}: ShareCollectionSheetProps<R>) {
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  // Done above a tablet's taskbar, the search field above the keyboard.
  const bottomInset = useSheetBottomInset();
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const [principals, setPrincipals] = React.useState<Principal[]>([]);
  const [directory, setDirectory] = React.useState<Omit<PrincipalListing, 'principals'>>({ status: 'ok' });
  const [loading, setLoading] = React.useState(false);
  const [shares, setShares] = React.useState<Record<string, R>>({});
  const [search, setSearch] = React.useState('');
  const [savingId, setSavingId] = React.useState<string | null>(null);
  // A typed address nobody listed has: looked up on its own, as the
  // Delegates dialog does (webmail delegate-dialog.tsx). The listing can
  // miss people the server still finds by address.
  const [lookup, setLookup] = React.useState<Lookup>({ state: 'idle' });

  React.useEffect(() => {
    if (!collection) return undefined;
    let cancelled = false;
    setShares(collection.shareWith ?? {});
    setSearch('');
    setLookup({ state: 'idle' });
    setLoading(true);
    void listPrincipals().then(({ principals: list, ...listing }) => {
      if (cancelled) return;
      setPrincipals(list);
      setDirectory(listing);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [collection]);

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
    // The sheet is mounted with its tab, before a session may exist
    // (an offline cold start): nobody to list yet, and no own id to read.
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
    if (!collection || savingId) return;
    setSavingId(principalId);
    try {
      await onShare(collection.id, principalId, rights);
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

  const typedAddress = search.trim();
  // Anyone listed with that address is a candidate, has access or is the user.
  const offerLookup = !loading && candidates.length === 0 && canLookUpAddress(search, principals);

  const lookUp = async () => {
    if (!offerLookup || lookup.state === 'busy' || savingId) return;
    setLookup({ state: 'busy' });
    const found = await findPrincipalByEmail(typedAddress);
    let ownIds: string[] = [];
    try {
      ownIds = [ownPrincipalId()];
    } catch {
      // No session yet: the server's answer still says who it is.
    }
    const result = lookupResult(typedAddress, found, ownIds);
    setLookup(result.lookup);
    const picked = result.picked;
    if (!picked) return;
    setPrincipals((prev) => (prev.some((p) => p.id === picked.id) ? prev : [...prev, picked]));
    if (shares[picked.id] == null) await applyShare(picked.id, addRights);
    setSearch('');
  };

  if (!collection) return null;

  // The list below is partial or empty for a reason the user can't see
  // otherwise; "Sharing is not available on this server." would be wrong.
  const notice = loading ? null : directoryNotice(directory);
  const noticeText =
    notice === 'failed' ? t('sharing.directory_failed', "Couldn't load the list of users and groups.")
      : notice === 'restricted'
        ? t(
          'sharing.directory_restricted',
          "Your server doesn't allow browsing its user directory, so only your groups and people who have shared with you are listed. An administrator can turn on directory queries in Stalwart's sharing settings.",
        )
        : notice === 'not_browsable'
          ? t('sharing.directory_not_browsable', "Your server doesn't let you browse its user directory.")
          : null;

  const renderPrincipalLabel = (principalId: string) => {
    const p = principalsById.get(principalId);
    // Stalwart 1.0 with directory queries off hides every principal the user
    // has no relationship with, so a sharee may have no name.
    const unresolved = !p && !loading;
    return (
      <View style={styles.principalInfo}>
        <Text style={styles.principalName} numberOfLines={1}>
          {p?.description || p?.name || (unresolved ? unknownPersonLabel(t) : principalId)}
        </Text>
        {/* Never the id in its place: Stalwart 1.0's are a letter or two
            ("e") and read as a broken address. */}
        {p?.email ? (
          <Text style={styles.principalEmail} numberOfLines={1}>{p.email}</Text>
        ) : null}
      </View>
    );
  };

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback accessible={false} onPress={onClose}>
        <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
          <TouchableWithoutFeedback accessible={false}>
            <View style={[styles.sheet, { paddingBottom: spacing.xxl + bottomInset }]}>
              <View style={styles.titleRow}>
                <Users size={18} color={c.textMuted} />
                <Text style={styles.title} numberOfLines={1}>
                  {t('sharing.title', 'Share "{name}"', { name: collection.name })}
                </Text>
              </View>

              <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                {sharedEntries.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('calendar.share.shared_with', 'Shared with')}</Text>
                    {sharedEntries.map(([principalId, rights]) => {
                      const preset = detectPreset ? detectPreset(rights) : detectSharePreset(rights, presets);
                      const busy = savingId === principalId;
                      return (
                        <View key={principalId} style={styles.shareRow}>
                          {renderPrincipalLabel(principalId)}
                          <View style={styles.roleChips}>
                            {presets.map((p) => (
                              <Pressable
                                key={p.key}
                                onPress={() => void applyShare(principalId, p.rights)}
                                disabled={busy}
                                style={[styles.chip, preset === p.key && styles.chipActive]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: preset === p.key, disabled: busy }}
                              >
                                <Text style={[styles.chipText, preset === p.key && styles.chipTextActive]}>
                                  {p.label}
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
                    accessibilityLabel={t('sharing.add_person', 'Add person or group')}
                    value={search}
                    onChangeText={(text) => {
                      setSearch(text);
                      setLookup({ state: 'idle' });
                    }}
                    placeholder={t('calendar.share.search_placeholder', 'Search by name or email')}
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  {noticeText ? (
                    <Text style={styles.empty} accessibilityLiveRegion="polite">{noticeText}</Text>
                  ) : null}
                  {loading ? (
                    <ActivityIndicator size="small" color={c.textMuted} style={{ marginTop: spacing.md }} />
                  ) : offerLookup ? (
                    <View>
                      <Pressable
                        onPress={() => void lookUp()}
                        disabled={lookup.state === 'busy' || !!savingId}
                        style={({ pressed }) => [styles.candidateRow, pressed && styles.rowPressed]}
                        accessibilityRole="button"
                        accessibilityState={{ busy: lookup.state === 'busy' }}
                      >
                        <Text style={[styles.principalName, styles.principalInfo]} numberOfLines={1}>
                          {lookup.state === 'busy'
                            ? t('delegates.looking_up', 'Looking up…')
                            : t('delegates.use_address', 'Use {address}', { address: typedAddress })}
                        </Text>
                        {lookup.state === 'busy' || savingId ? (
                          <ActivityIndicator size="small" color={c.textMuted} />
                        ) : (
                          <UserPlus size={18} color={c.primary} />
                        )}
                      </Pressable>
                      {lookupMessage(lookup, t) ? (
                        <Text style={styles.empty} accessibilityLiveRegion="polite">{lookupMessage(lookup, t)}</Text>
                      ) : null}
                    </View>
                  ) : candidates.length === 0 ? (
                    notice && !search.trim() ? null : (
                      <Text style={styles.empty}>
                        {principals.length === 0 && !notice
                          ? t('calendar.share.no_principals', 'Sharing is not available on this server.')
                          : t('calendar.share.no_matches', 'No matches')}
                      </Text>
                    )
                  ) : (
                    candidates.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => void applyShare(p.id, addRights)}
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
