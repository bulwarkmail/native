import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Folder, FileText, Trash2, UserPlus, Users } from 'lucide-react-native';

import { isFolder, listPrincipals, ownPrincipalId, setFileNodeShare, type PrincipalListing } from '../../api/files';
import type { FileNode, FileNodeRights, Principal } from '../../api/types';
import { directoryNotice } from '../../lib/principal-directory';
import { fileErrorMessage } from '../../lib/file-errors';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

type RolePreset = 'read' | 'readWrite' | 'manager';

// Same presets the webmail's share dialog offers (#408). "custom" rights set
// by another client are shown as-is and left untouched until the user picks a
// preset for that principal.
const FILE_PRESETS: Record<RolePreset, FileNodeRights> = {
  read: {
    mayRead: true, mayAddChildren: false, mayRename: false,
    mayDelete: false, mayModifyContent: false, mayShare: false,
  },
  readWrite: {
    mayRead: true, mayAddChildren: true, mayRename: true,
    mayDelete: true, mayModifyContent: true, mayShare: false,
  },
  manager: {
    mayRead: true, mayAddChildren: true, mayRename: true,
    mayDelete: true, mayModifyContent: true, mayShare: true,
  },
};

// The webmail's sharing presets (same rights, same names).
const PRESET_LABEL_KEYS: Record<RolePreset, [string, string]> = {
  read: ['sharing.preset.read', 'Read only'],
  readWrite: ['sharing.preset.readWrite', 'Read & write'],
  manager: ['sharing.preset.manager', 'Manager'],
};

const PRESET_ORDER: RolePreset[] = ['read', 'readWrite', 'manager'];

function detectPreset(rights: FileNodeRights): RolePreset | 'custom' {
  for (const preset of PRESET_ORDER) {
    const expected = FILE_PRESETS[preset];
    const keys = Object.keys(expected) as (keyof FileNodeRights)[];
    if (keys.every((k) => expected[k] === (rights[k] ?? false))) return preset;
  }
  return 'custom';
}

interface ShareSheetProps {
  node: FileNode | null;
  onClose: () => void;
  /** Fired after any successful share change so the parent can refresh. */
  onChanged: () => void;
}

export default function ShareSheet({ node, onClose, onChanged }: ShareSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [directory, setDirectory] = useState<Omit<PrincipalListing, 'principals'>>({ status: 'ok' });
  const [loadingPrincipals, setLoadingPrincipals] = useState(false);
  const [shares, setShares] = useState<Record<string, FileNodeRights>>({});
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return undefined;
    let cancelled = false;
    setShares(node.shareWith ?? {});
    setSearch('');
    setLoadingPrincipals(true);
    void listPrincipals().then(({ principals: list, ...listing }) => {
      if (cancelled) return;
      setPrincipals(list);
      setDirectory(listing);
      setLoadingPrincipals(false);
    });
    return () => {
      cancelled = true;
    };
  }, [node]);

  const principalsById = useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of principals) map.set(p.id, p);
    return map;
  }, [principals]);

  const sharedEntries = useMemo(
    () => Object.entries(shares).filter(([, rights]) => rights != null),
    [shares],
  );

  const candidates = useMemo(() => {
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

  const applyShare = useCallback(
    async (principalId: string, rights: FileNodeRights | null) => {
      if (!node || savingId) return;
      setSavingId(principalId);
      try {
        await setFileNodeShare(node.id, principalId, rights);
        setShares((prev) => {
          const next = { ...prev };
          if (rights == null) delete next[principalId];
          else next[principalId] = rights;
          return next;
        });
        onChanged();
      } catch (e) {
        Alert.alert(t('files.share_error', 'Failed to update sharing'), fileErrorMessage(e, t));
      } finally {
        setSavingId(null);
      }
    },
    [node, savingId, onChanged, t],
  );

  if (!node) return null;
  const Icon = isFolder(node) ? Folder : FileText;

  // The list below is partial or empty for a reason the user can't see
  // otherwise; say so instead of "No other users found".
  const notice = loadingPrincipals ? null : directoryNotice(directory);
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
    const unresolved = !p && !loadingPrincipals;
    return (
      <View style={styles.principalInfo}>
        <Text style={styles.principalName} numberOfLines={1}>
          {p?.description || p?.name || (unresolved ? t('sharing.unknown_user', 'Unknown user') : principalId)}
        </Text>
        {p?.email || unresolved ? (
          <Text style={styles.principalEmail} numberOfLines={1}>
            {p?.email || principalId}
          </Text>
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
                <Icon size={18} color={c.textMuted} />
                <Text style={styles.title} numberOfLines={1}>
                  {t('sharing.title', 'Share "{name}"', { name: node.name })}
                </Text>
              </View>
              {isFolder(node) ? (
                <Text style={styles.subtitle}>
                  {t('files.share_folder_hint', 'Sharing a folder shares everything inside it.')}
                </Text>
              ) : null}

              <ScrollView
                style={styles.scroll}
                keyboardShouldPersistTaps="handled"
              >
                {sharedEntries.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('files.shared_with', 'Shared with')}</Text>
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
                                onPress={() => void applyShare(principalId, FILE_PRESETS[p])}
                                disabled={busy}
                                style={[styles.chip, preset === p && styles.chipActive]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: preset === p, disabled: busy }}
                              >
                                <Text
                                  style={[styles.chipText, preset === p && styles.chipTextActive]}
                                >
                                  {t(PRESET_LABEL_KEYS[p][0], PRESET_LABEL_KEYS[p][1])}
                                </Text>
                              </Pressable>
                            ))}
                            {preset === 'custom' ? (
                              <Text style={styles.customLabel}>{t('files.share_role_custom', 'Custom')}</Text>
                            ) : null}
                          </View>
                          {busy ? (
                            <ActivityIndicator size="small" color={c.textMuted} />
                          ) : (
                            <Pressable
                              onPress={() => void applyShare(principalId, null)}
                              hitSlop={8}
                              accessibilityLabel={t('files.share_remove', 'Remove access')}
                            >
                              <Trash2 size={18} color={c.error} />
                            </Pressable>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <View style={styles.emptyRow}>
                    <Users size={18} color={c.textMuted} />
                    <Text style={styles.emptyText}>{t('files.share_empty', 'Not shared with anyone yet')}</Text>
                  </View>
                )}

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('files.share_add_people', 'Add people')}</Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('files.share_search_placeholder', 'Search by name or email')}
                    placeholderTextColor={c.textMuted}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {noticeText ? (
                    <Text style={styles.noMatches} accessibilityLiveRegion="polite">{noticeText}</Text>
                  ) : null}
                  {loadingPrincipals ? (
                    <ActivityIndicator
                      size="small"
                      color={c.textMuted}
                      style={{ marginTop: spacing.sm }}
                    />
                  ) : candidates.length === 0 ? (
                    notice && !search.trim() ? null : (
                      <Text style={styles.noMatches}>
                        {principals.length === 0 && !notice
                          ? t('files.share_no_users', 'No other users found')
                          : t('files.share_no_matches', 'No matches')}
                      </Text>
                    )
                  ) : (
                    candidates.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => void applyShare(p.id, FILE_PRESETS.read)}
                        disabled={savingId != null}
                        style={({ pressed }) => [
                          styles.candidateRow,
                          pressed && { backgroundColor: c.surfaceHover },
                        ]}
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
                <Text style={styles.doneText}>{t('files.done', 'Done')}</Text>
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
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xxl,
      paddingHorizontal: spacing.md,
      maxHeight: '80%',
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    title: {
      ...typography.h3,
      color: c.text,
      flexShrink: 1,
    },
    subtitle: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      paddingHorizontal: spacing.sm,
      marginTop: 2,
    },
    scroll: {
      marginTop: spacing.sm,
    },
    section: {
      marginTop: spacing.md,
    },
    sectionLabel: {
      fontSize: typography.caption.fontSize,
      fontWeight: '600' as const,
      color: c.textMuted,
      textTransform: 'uppercase' as const,
      paddingHorizontal: spacing.sm,
      marginBottom: spacing.xs,
    },
    shareRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    principalInfo: {
      flex: 1,
      minWidth: 0,
    },
    principalName: {
      fontSize: typography.body.fontSize,
      color: c.text,
    },
    principalEmail: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
    },
    roleChips: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    chip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipActive: {
      backgroundColor: c.primaryBg,
      borderColor: c.primary,
    },
    chipText: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
    },
    chipTextActive: {
      color: c.primary,
      fontWeight: '600' as const,
    },
    customLabel: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      fontStyle: 'italic' as const,
    },
    emptyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
    },
    emptyText: {
      fontSize: typography.body.fontSize,
      color: c.textMuted,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: c.text,
      fontSize: typography.body.fontSize,
      backgroundColor: c.surface,
      marginHorizontal: spacing.sm,
    },
    noMatches: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    candidateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    doneBtn: {
      marginTop: spacing.md,
      alignSelf: 'stretch',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.primary,
    },
    doneText: {
      color: c.primaryForeground,
      fontWeight: '600' as const,
      fontSize: typography.body.fontSize,
    },
  });
}
