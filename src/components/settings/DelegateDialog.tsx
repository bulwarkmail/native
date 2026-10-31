import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Info, X } from '../icons';
import Button from '../Button';
import SenderAvatar from '../SenderAvatar';
import { SafeAreaModal } from '../SafeAreaModal';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useModalKeyboardPadding } from '../../lib/sheet-bottom-inset';
import { findPrincipalByEmail } from '../../api/delegation';
import type { Principal } from '../../api/types';
import type { PrincipalListing } from '../../api/files';
import type { ShareChange, ShareChangeResult, ShareTarget } from '../../lib/delegation/share-batch';
import type { AccessLevel } from '../../lib/delegation/share-rights';
import {
  buildGrantChanges,
  DEFAULT_DELEGATE_SCOPE,
  failedChanges,
  scopeIsEmpty,
  type CollectionScope,
  type DelegateScope,
  type LevelChoice,
  type MailScope,
} from '../../lib/delegation/delegation';
import {
  canLookUpAddress,
  delegateCandidates,
  lookupResult,
  principalDisplay,
  type Lookup,
} from '../../lib/delegation/display';

// Ported from the webmail's components/settings/delegates/delegate-dialog.tsx:
// "Give access" and "Change". One person, what they get, and with which
// rights, applied to every folder, calendar and address book in one batch.

export interface DelegateDialogProps {
  targets: ShareTarget[];
  directory: PrincipalListing | null;
  /** The user's own principal ids, never offered. */
  ownIds: string[];
  /** The user's own addresses: typing one says "That's you". */
  ownEmails: string[];
  /** Ids that already have access to something. */
  existingIds: Set<string>;
  /** Set for "Change": the person, and what they have now. */
  initial?: { principal: Principal; scope: DelegateScope; level: LevelChoice };
  levels: AccessLevel[];
  /** The admin limited the rights (sharingRights). */
  levelsRestricted: boolean;
  /** The server keeps "mark as read" and flags as one right on folders (Stalwart 1.0). */
  seenSetsKeywords: boolean;
  /** Sends the changes; resolves to a result per change. */
  apply: (changes: ShareChange[]) => Promise<ShareChangeResult[]>;
  onApplied: (principal: Principal, results: ShareChangeResult[]) => void;
  onClose: () => void;
}

export function DelegateDialog({
  targets, directory, ownIds, ownEmails, existingIds, initial, levels, levelsRestricted, seenSetsKeywords, apply, onApplied, onClose,
}: DelegateDialogProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  // The Android dialog doesn't shrink for the keyboard; the body ends above it.
  const keyboardPadding = useModalKeyboardPadding();
  const changing = !!initial;

  const [principal, setPrincipal] = useState<Principal | null>(initial?.principal ?? null);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [scope, setScope] = useState<DelegateScope>(initial?.scope ?? DEFAULT_DELEGATE_SCOPE);
  const [level, setLevel] = useState<LevelChoice>(() => {
    const wanted = initial?.level ?? 'read';
    return wanted === 'keep' || levels.includes(wanted) ? wanted : levels[0];
  });
  // "Keep as it is" is offered where Change started with it, and stays offered.
  const keep = {
    mail: initial?.scope.mail === 'keep',
    calendars: initial?.scope.calendars === 'keep',
    addressBooks: initial?.scope.addressBooks === 'keep',
    level: initial?.level === 'keep',
  };
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<ShareChangeResult[] | null>(null);

  const has = (kind: ShareTarget['kind']) => targets.some((target) => target.kind === kind);
  const directoryOff = directory?.status === 'restricted' && !!directory.directoryQueriesOff;

  const candidates = useMemo(
    () => delegateCandidates(directory?.principals ?? [], ownIds, query),
    [directory, ownIds, query],
  );
  const typedAddress = query.trim();
  const canLookUp = canLookUpAddress(query, candidates);

  const lookUp = async () => {
    if (!canLookUp || lookup.state === 'busy') return;
    if (ownEmails.some((email) => email.toLowerCase() === typedAddress.toLowerCase())) {
      setLookup({ state: 'self' });
      return;
    }
    setLookup({ state: 'busy' });
    const found = await findPrincipalByEmail(typedAddress);
    const result = lookupResult(typedAddress, found, ownIds);
    if (result.picked) setPrincipal(result.picked);
    setLookup(result.lookup);
  };

  const send = async (changes: ShareChange[]) => {
    if (!principal) return;
    setSaving(true);
    try {
      const results = await apply(changes);
      const failed = failedChanges(results);
      onApplied(principal, results);
      if (failed.length === 0) onClose();
      else setFailures(failed);
    } finally {
      setSaving(false);
    }
  };

  const changes = useMemo(
    () => (principal ? buildGrantChanges(targets, principal.id, scope, level, { replace: changing }) : []),
    [targets, principal, scope, level, changing],
  );
  const nothingToDo = changing ? changes.length === 0 : scopeIsEmpty(scope);

  const submit = () => {
    if (!principal || nothingToDo) return;
    void send(changes);
  };
  const retry = () => {
    if (failures) void send(failures.map((f) => f.change));
  };
  const close = () => {
    if (!saving) onClose();
  };

  const keepLabel = t('delegates.keep', 'Keep as it is');
  const none = t('delegates.none', 'None');

  return (
    <SafeAreaModal supportedOrientations={MODAL_ORIENTATIONS} visible animationType="slide" onRequestClose={close}>
      <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView style={[styles.screen, { paddingBottom: keyboardPadding }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {changing && principal
                ? t('delegates.dialog_title_change', 'Change access for {name}', { name: principalDisplay(principal).name })
                : t('delegates.dialog_title_add', 'Give access')}
            </Text>
            <Pressable
              onPress={close}
              disabled={saving}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
              style={styles.closeBtn}
            >
              <X size={22} color={c.textMuted} />
            </Pressable>
          </View>

          {failures ? (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.label} accessibilityLiveRegion="assertive">
                {t('delegates.partial_title', "These couldn't be changed. The rest is done.")}
              </Text>
              <View style={styles.box}>
                {failures.map((f, index) => (
                  <View key={`${f.change.kind}:${f.change.id}`} style={[styles.failRow, index > 0 && styles.rowBorder]}>
                    <Text style={styles.text}>
                      <Text style={styles.textStrong}>{f.change.name}</Text>
                      {' · '}{t(`delegates.kind.${f.change.kind}`, f.change.kind)}
                    </Text>
                    {f.error ? <Text style={styles.small}>{f.error}</Text> : null}
                  </View>
                ))}
              </View>
            </ScrollView>
          ) : (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
              <View style={styles.field}>
                <Text style={styles.label}>{t('delegates.person', 'Person')}</Text>
                {principal ? (
                  <View style={styles.pickedCard}>
                    <SenderAvatar name={principal.name} email={principal.email ?? ''} size={32} disableImages />
                    <PrincipalText principal={principal} styles={styles} groupLabel={t('delegates.group', 'Group')} />
                    {!changing && (
                      <Button variant="ghost" size="sm" onPress={() => { setPrincipal(null); setLookup({ state: 'idle' }); }}>
                        {t('delegates.change_person', 'Change')}
                      </Button>
                    )}
                  </View>
                ) : (
                  <View style={styles.field}>
                    <TextInput
                      value={query}
                      onChangeText={(text) => { setQuery(text); setLookup({ state: 'idle' }); }}
                      onSubmitEditing={() => void lookUp()}
                      placeholder={t('delegates.search_placeholder', 'Name or email address')}
                      placeholderTextColor={c.textMuted}
                      accessibilityLabel={t('delegates.person', 'Person')}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      returnKeyType="search"
                      autoFocus
                      style={styles.input}
                    />
                    {directory === null ? (
                      <View style={styles.inline}>
                        <ActivityIndicator size="small" color={c.textMuted} />
                        <Text style={styles.small}>{t('delegates.loading', 'Loading…')}</Text>
                      </View>
                    ) : (
                      <View style={styles.box}>
                        {candidates.length === 0 && !canLookUp && (
                          <Text style={[styles.small, styles.candidatePad]}>{t('delegates.no_match', 'Nobody found.')}</Text>
                        )}
                        {candidates.slice(0, 50).map((p, index) => (
                          <Pressable
                            key={p.id}
                            onPress={() => setPrincipal(p)}
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.candidate, index > 0 && styles.rowBorder, pressed && styles.pressed]}
                          >
                            <SenderAvatar name={p.name} email={p.email ?? ''} size={28} disableImages />
                            <PrincipalText principal={p} styles={styles} groupLabel={t('delegates.group', 'Group')} />
                            {existingIds.has(p.id) && <Text style={styles.small}>{t('delegates.has_access', 'Has access')}</Text>}
                          </Pressable>
                        ))}
                        {canLookUp && (
                          <Pressable
                            onPress={() => void lookUp()}
                            disabled={lookup.state === 'busy'}
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.candidate, candidates.length > 0 && styles.rowBorder, pressed && styles.pressed]}
                          >
                            {lookup.state === 'busy' && <ActivityIndicator size="small" color={c.textMuted} />}
                            <Text style={styles.text}>
                              {lookup.state === 'busy'
                                ? t('delegates.looking_up', 'Looking up…')
                                : t('delegates.use_address', 'Use {address}', { address: typedAddress })}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    )}
                    <View accessibilityLiveRegion="polite">
                      {lookup.state === 'notFound' && (
                        <Text style={styles.errorSmall}>{t('delegates.not_found', 'Nobody on this server has the address {address}.', { address: lookup.address })}</Text>
                      )}
                      {lookup.state === 'failed' && <Text style={styles.errorSmall}>{t('delegates.lookup_failed', "Couldn't look up this address.")}</Text>}
                      {lookup.state === 'self' && <Text style={styles.errorSmall}>{t('delegates.is_you', "That's you.")}</Text>}
                      {(directoryOff || lookup.state === 'directoryOff') && (
                        <Text style={styles.small}>
                          {directoryOff ? `${t('delegates.known_only', 'Only your groups and people who have shared something with you are listed.')} ` : ''}
                          {t('delegates.directory_off_note', 'Your administrator has to turn on directory lookups in Stalwart before you can add someone new.')}
                        </Text>
                      )}
                      {directory?.status === 'error' && (
                        <Text style={styles.small}>{t('delegates.directory_failed', "Couldn't load the list of people and groups.")}</Text>
                      )}
                    </View>
                  </View>
                )}
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>{t('delegates.what', 'What')}</Text>
                {has('mailbox') && (
                  <Choice<MailScope>
                    label={t('delegates.mail', 'Mail')}
                    value={scope.mail}
                    onChange={(mail) => setScope({ ...scope, mail })}
                    options={[
                      ...keepOption<MailScope>(keep.mail, keepLabel),
                      ['all', t('delegates.mail_all', 'All folders')],
                      ['inbox', t('delegates.mail_inbox', 'Inbox only')],
                      ['none', none],
                    ]}
                    styles={styles}
                  />
                )}
                {has('calendar') && (
                  <Choice<CollectionScope>
                    label={t('delegates.calendars', 'Calendars')}
                    value={scope.calendars}
                    onChange={(calendars) => setScope({ ...scope, calendars })}
                    options={[
                      ...keepOption<CollectionScope>(keep.calendars, keepLabel),
                      ['default', t('delegates.calendars_default', 'Default calendar')],
                      ['all', t('delegates.calendars_all', 'All calendars')],
                      ['none', none],
                    ]}
                    styles={styles}
                  />
                )}
                {has('addressBook') && (
                  <Choice<CollectionScope>
                    label={t('delegates.address_books', 'Contacts')}
                    value={scope.addressBooks}
                    onChange={(addressBooks) => setScope({ ...scope, addressBooks })}
                    options={[
                      ...keepOption<CollectionScope>(keep.addressBooks, keepLabel),
                      ['default', t('delegates.address_books_default', 'Default address book')],
                      ['all', t('delegates.address_books_all', 'All address books')],
                      ['none', none],
                    ]}
                    styles={styles}
                  />
                )}
                {!changing && scopeIsEmpty(scope) && (
                  <Text style={styles.errorSmall}>{t('delegates.empty_scope', 'Choose mail, calendars or contacts.')}</Text>
                )}
                {changing && (
                  <Text style={styles.small}>
                    {t('delegates.change_note', 'Folders, calendars and address books you leave out lose access. Shared files stay as they are; Remove access takes those away too.')}
                  </Text>
                )}
              </View>

              <View style={styles.field} accessibilityRole="radiogroup">
                <Text style={styles.label}>{t('delegates.rights', 'Rights')}</Text>
                {[...(keep.level ? ['keep' as const] : []), ...levels].map((option) => {
                  const selected = level === option;
                  const hintKey = option === 'read' && seenSetsKeywords ? 'delegates.rights_read_hint_flags' : `delegates.rights_${option}_hint`;
                  return (
                    <Pressable
                      key={option}
                      onPress={() => setLevel(option)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      style={styles.radioRow}
                    >
                      <View style={[styles.radio, selected && styles.radioOn]}>
                        {selected && <View style={styles.radioDot} />}
                      </View>
                      <View style={styles.radioText}>
                        <Text style={styles.text}>{t(`delegates.rights_${option}`, option)}</Text>
                        <Text style={styles.small}>{t(hintKey, '')}</Text>
                      </View>
                    </Pressable>
                  );
                })}
                {levelsRestricted && (
                  <Text style={styles.small}>{t('settings.org_locked', 'Set by your organisation')}</Text>
                )}
              </View>

              {changing && nothingToDo && (
                <Text style={styles.small} accessibilityLiveRegion="polite">
                  {t('delegates.nothing_to_change', 'Nothing to change. Pick what they should get, or use Remove access.')}
                </Text>
              )}

              <View style={styles.note}>
                <Info size={16} color={c.textMuted} />
                <Text style={[styles.small, styles.noteText]}>
                  {t('delegates.send_note', "Delegates can read and organise your mail and calendar. Stalwart doesn't let them send as you or on your behalf. To share one address between several people, ask your administrator for a shared mailbox.")}
                </Text>
              </View>
            </ScrollView>
          )}

          <View style={styles.footer}>
            {failures ? (
              <>
                <Button variant="outline" onPress={close} disabled={saving}>{t('common.close', 'Close')}</Button>
                <Button onPress={retry} loading={saving}>{t('delegates.retry', 'Try again')}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onPress={close} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
                <Button onPress={submit} loading={saving} disabled={!principal || nothingToDo}>
                  {changing ? t('delegates.apply_change', 'Save') : t('delegates.apply_add', 'Give access')}
                </Button>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function PrincipalText({ principal, styles, groupLabel }: { principal: Principal; styles: Styles; groupLabel: string }) {
  const { name, detail } = principalDisplay(principal);
  return (
    <View style={styles.principalText}>
      <View style={styles.inline}>
        <Text style={styles.textStrong} numberOfLines={1}>{name}</Text>
        {principal.type === 'group' && <Text style={styles.groupTag}>{groupLabel}</Text>}
      </View>
      {detail ? <Text style={styles.small} numberOfLines={1}>{detail}</Text> : null}
    </View>
  );
}

function keepOption<T extends string>(offered: boolean, label: string): [T, string][] {
  return offered ? [['keep' as T, label]] : [];
}

function Choice<T extends string>({ label, value, onChange, options, styles }: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: [T, string][];
  styles: Styles;
}) {
  return (
    <View style={styles.choice} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.choiceLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map(([option, text]) => {
          const selected = value === option;
          return (
            <Pressable
              key={option}
              onPress={() => onChange(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              hitSlop={4}
              style={[styles.chip, selected && styles.chipOn]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{text}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.h3, color: c.text, flex: 1 },
    closeBtn: { padding: 6, borderRadius: radius.md },
    body: { flex: 1 },
    bodyContent: { padding: spacing.lg, gap: spacing.xl, width: '100%', maxWidth: 640, alignSelf: 'center' },
    field: { gap: spacing.sm },
    label: { ...typography.bodyMedium, color: c.text },
    text: { ...typography.body, color: c.text },
    textStrong: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
    small: { ...typography.caption, color: c.textMuted },
    errorSmall: { ...typography.caption, color: c.error },
    inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    input: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      color: c.text,
      backgroundColor: c.surface,
      ...typography.body,
    },
    box: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
    candidate: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, paddingVertical: spacing.sm },
    candidatePad: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    pressed: { backgroundColor: c.muted },
    pickedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    principalText: { flex: 1, minWidth: 0 },
    groupTag: { ...typography.caption, color: c.textMuted, backgroundColor: c.muted, paddingHorizontal: 4, borderRadius: radius.sm },
    failRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2 },
    choice: { gap: spacing.xs },
    choiceLabel: { ...typography.body, color: c.textMuted },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipOn: { borderColor: c.primary, backgroundColor: c.muted },
    chipText: { ...typography.caption, color: c.textMuted },
    chipTextOn: { color: c.text },
    radioRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs },
    radio: {
      width: 20, height: 20, borderRadius: 10,
      borderWidth: 2, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
      marginTop: 1,
    },
    radioOn: { borderColor: c.primary },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary },
    radioText: { flex: 1, gap: 2 },
    note: { flexDirection: 'row', gap: spacing.sm, backgroundColor: c.muted, borderRadius: radius.md, padding: spacing.md },
    noteText: { flex: 1 },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  });
}
