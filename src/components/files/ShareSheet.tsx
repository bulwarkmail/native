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

import { getPrincipals, isFolder, ownPrincipalId, setFileNodeShare } from '../../api/files';
import type { FileNode, FileNodeRights, Principal } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

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

const PRESET_LABELS: Record<RolePreset, string> = {
  read: 'Viewer',
  readWrite: 'Editor',
  manager: 'Manager',
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

  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [loadingPrincipals, setLoadingPrincipals] = useState(false);
  const [shares, setShares] = useState<Record<string, FileNodeRights>>({});
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return;
    setShares(node.shareWith ?? {});
    setSearch('');
    setLoadingPrincipals(true);
    getPrincipals()
      .then(setPrincipals)
      .catch(() => setPrincipals([]))
      .finally(() => setLoadingPrincipals(false));
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
        Alert.alert('Sharing failed', e instanceof Error ? e.message : String(e));
      } finally {
        setSavingId(null);
      }
    },
    [node, savingId, onChanged],
  );

  if (!node) return null;
  const Icon = isFolder(node) ? Folder : FileText;

  const renderPrincipalLabel = (principalId: string) => {
    const p = principalsById.get(principalId);
    return (
      <View style={styles.principalInfo}>
        <Text style={styles.principalName} numberOfLines={1}>
          {p?.description || p?.name || principalId}
        </Text>
        {p?.email ? (
          <Text style={styles.principalEmail} numberOfLines={1}>
            {p.email}
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
                  Share “{node.name}”
                </Text>
              </View>
              {isFolder(node) ? (
                <Text style={styles.subtitle}>
                  Sharing a folder shares everything inside it.
                </Text>
              ) : null}

              <ScrollView
                style={styles.scroll}
                keyboardShouldPersistTaps="handled"
              >
                {sharedEntries.length > 0 ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>Shared with</Text>
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
                              >
                                <Text
                                  style={[styles.chipText, preset === p && styles.chipTextActive]}
                                >
                                  {PRESET_LABELS[p]}
                                </Text>
                              </Pressable>
                            ))}
                            {preset === 'custom' ? (
                              <Text style={styles.customLabel}>Custom</Text>
                            ) : null}
                          </View>
                          {busy ? (
                            <ActivityIndicator size="small" color={c.textMuted} />
                          ) : (
                            <Pressable
                              onPress={() => void applyShare(principalId, null)}
                              hitSlop={8}
                              accessibilityLabel="Remove access"
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
                    <Text style={styles.emptyText}>Not shared with anyone yet</Text>
                  </View>
                )}

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Add people</Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search by name or email"
                    placeholderTextColor={c.textMuted}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {loadingPrincipals ? (
                    <ActivityIndicator
                      size="small"
                      color={c.textMuted}
                      style={{ marginTop: spacing.sm }}
                    />
                  ) : candidates.length === 0 ? (
                    <Text style={styles.noMatches}>
                      {principals.length === 0 ? 'No other users found' : 'No matches'}
                    </Text>
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
                <Text style={styles.doneText}>Done</Text>
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
