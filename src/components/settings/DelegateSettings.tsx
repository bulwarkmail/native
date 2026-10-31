import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { UserPlus } from '../icons';
import Button from '../Button';
import SenderAvatar from '../SenderAvatar';
import { SettingsSection } from './settings-section';
import { DelegateDialog } from './DelegateDialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useAuthStore } from '../../stores/auth-store';
import { useAccountStore } from '../../stores/account-store';
import { toast } from '../../stores/toast-store';
import { jmapClient } from '../../api/jmap-client';
import { listPrincipals, type PrincipalListing } from '../../api/files';
import { applyShareChanges, getShareTargets, sharesSeenWithKeywords } from '../../api/delegation';
import type { Principal } from '../../api/types';
import { servedLoginOf } from '../../lib/draft-login';
import { loginMovedFrom } from '../../lib/compose-login';
import type { ShareChange, ShareChangeResult, ShareTarget } from '../../lib/delegation/share-batch';
import type { ShareKind } from '../../lib/delegation/share-rights';
import {
  allowedLevels,
  buildRevokeChanges,
  changeStartFor,
  failedChanges,
  summarizeDelegates,
  type DelegateSummary,
} from '../../lib/delegation/delegation';
import { describeSummary, principalDisplay, resolvePrincipal } from '../../lib/delegation/display';
import {
  pruneRememberedPrincipals,
  rememberPrincipals,
  rememberedPrincipals,
} from '../../lib/delegation/known-principals';
import { delegationPolicy } from '../../lib/delegation/policy';

// Ported from the webmail's components/settings/delegates/delegates-settings.tsx:
// Settings > Sharing > Delegates. Give someone access to mail, calendars and
// contacts in one step, and see and take back who has access to what. The
// admin's hiding, rights limit and app gates come from lib/delegation/policy
// (nothing is limited until the app has the org policy).

// Names kept for a login go with it: removed from the app, or everyone signed out.
useAccountStore.subscribe((state, prev) => {
  if (state.accounts !== prev.accounts) void pruneRememberedPrincipals(state.accounts.map((a) => a.id));
});

type DialogState = { mode: 'add' } | { mode: 'change'; summary: DelegateSummary } | null;

export function DelegateSettings() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const session = useAuthStore((s) => s.session);
  const accountKey = useAuthStore((s) => s.activeAccountId) ?? '';
  const username = useAuthStore((s) => s.username);
  const policy = delegationPolicy();
  const levels = useMemo(() => allowedLevels(policy.allowedValues), [policy.allowedValues]);
  const { calendarsEnabled, contactsEnabled, filesEnabled } = policy;

  const [targets, setTargets] = useState<ShareTarget[] | null>(null);
  const [failedKinds, setFailedKinds] = useState<ShareKind[]>([]);
  const [directory, setDirectory] = useState<PrincipalListing | null>(null);
  const [remembered, setRemembered] = useState<Map<string, Principal>>(() => new Map());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // The login the page was read in: changes are sent only while it is active.
  const ownerRef = useRef<string | null>(null);
  // Each read is numbered; an answer that arrives after a newer read started
  // (another account) is dropped instead of shown.
  const readSeq = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++readSeq.current;
    const owner = servedLoginOf(jmapClient);
    const result = await getShareTargets({ calendars: calendarsEnabled, contacts: contactsEnabled, files: filesEnabled });
    if (seq !== readSeq.current || loginMovedFrom(owner)) return;
    ownerRef.current = owner;
    setTargets(result.targets);
    setFailedKinds(result.failed);
  }, [calendarsEnabled, contactsEnabled, filesEnabled]);

  useEffect(() => {
    if (!session || policy.hidden) return undefined;
    let cancelled = false;
    const reads = readSeq;
    setTargets(null);
    setFailedKinds([]);
    setDirectory(null);
    setDialog(null);
    void rememberedPrincipals(accountKey).then((map) => {
      if (!cancelled) setRemembered(map);
    });
    void reload();
    void listPrincipals().then((listing) => {
      if (!cancelled) setDirectory(listing);
    });
    return () => {
      cancelled = true;
      reads.current++;
    };
  }, [session, accountKey, policy.hidden, reload]);

  const ownId = session ? jmapClient.accountId : '';
  const ownIds = useMemo(() => (ownId ? [ownId] : []), [ownId]);
  const ownEmails = useMemo(() => {
    const emails = new Set<string>();
    if (username?.includes('@')) emails.add(username);
    for (const p of directory?.principals ?? []) if (ownIds.includes(p.id) && p.email) emails.add(p.email);
    return [...emails];
  }, [username, directory, ownIds]);
  const summaries = useMemo(() => (targets ? summarizeDelegates(targets, ownIds) : []), [targets, ownIds]);

  // An account shared with the user is in the session under the owner's address.
  const sessionAccounts = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, info] of Object.entries(session?.accounts ?? {})) {
      if (id !== ownId && info.name) map.set(id, info.name);
    }
    return map;
  }, [session, ownId]);
  const principalFor = useCallback(
    (id: string) => resolvePrincipal(id, { directory: directory?.principals ?? [], remembered, sessionAccounts }),
    [directory, remembered, sessionAccounts],
  );

  // Remember the names of the people who have access, so the list can name
  // them when the directory no longer does. Never the whole directory.
  useEffect(() => {
    if (!accountKey || summaries.length === 0 || !directory) return;
    const named = summaries
      .map((s) => directory.principals.find((p) => p.id === s.principalId))
      .filter((p): p is Principal => !!p);
    if (named.length > 0) void rememberPrincipals(accountKey, named);
  }, [accountKey, summaries, directory]);

  if (policy.hidden || !session) return null;

  // Change and Remove act on everything the person has; with a type unread,
  // that isn't known, so they wait until a read succeeds.
  const incomplete = failedKinds.length > 0;

  const send = (changes: ShareChange[]): Promise<ShareChangeResult[]> => {
    const owner = ownerRef.current;
    return applyShareChanges(changes, () => !loginMovedFrom(owner));
  };

  const onApplied = (principal: Principal, results: ShareChangeResult[]) => {
    void rememberPrincipals(accountKey, [principal]).then(() => rememberedPrincipals(accountKey)).then(setRemembered);
    if (failedChanges(results).length === 0) {
      toast.success(dialog?.mode === 'change'
        ? t('delegates.updated', 'Access updated')
        : t('delegates.applied', '{name} now has access', { name: principalDisplay(principal).name }));
    }
    void reload();
  };

  const nameOf = (id: string) => {
    const principal = principalFor(id);
    return principal ? principalDisplay(principal).name : t('delegates.unknown_person', 'Unknown person');
  };

  const remove = async (summary: DelegateSummary) => {
    if (!targets || incomplete) return;
    setRemovingId(summary.principalId);
    try {
      const results = await send(buildRevokeChanges(targets, summary.principalId));
      const failed = failedChanges(results);
      if (failed.length === 0) toast.success(t('delegates.removed', 'Access removed'));
      else toast.error(t('delegates.remove_partial', 'These still have access: {items}', { items: failed.map((f) => f.change.name).join(', ') }));
      await reload();
    } finally {
      setRemovingId(null);
    }
  };

  const confirmRemove = (summary: DelegateSummary) => {
    const name = nameOf(summary.principalId);
    Alert.alert(
      t('delegates.remove_title', 'Remove access for {name}?', { name }),
      t('delegates.remove_message', '{name} loses access to everything you shared from your own account: mail, calendars, contacts and files.', { name }),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('delegates.remove', 'Remove access'), style: 'destructive', onPress: () => void remove(summary) },
      ],
    );
  };

  return (
    <SettingsSection
      title={t('delegates.title', 'Delegates')}
      description={t('delegates.description', 'Give someone access to your mail, calendars and contacts in one step, and see who has access to what.')}
    >
      <View style={styles.giveRow}>
        <Button
          onPress={() => setDialog({ mode: 'add' })}
          disabled={!targets}
          icon={<UserPlus size={16} color={c.primaryForeground} />}
        >
          {t('delegates.give_access', 'Give access')}
        </Button>
      </View>

      <View style={styles.block}>
        <Text style={styles.heading}>{t('delegates.who_has_access', 'Who has access')}</Text>
        {incomplete && (
          <View style={styles.inline} accessibilityLiveRegion="polite">
            <Text style={styles.errorSmall}>
              {t('delegates.read_failed', "Some of your sharing couldn't be read, so Change and Remove access wait until it can.")}
            </Text>
            <Button variant="outline" size="sm" onPress={() => void reload()}>{t('delegates.retry', 'Try again')}</Button>
          </View>
        )}
        {targets === null ? (
          <View style={styles.inline}>
            <ActivityIndicator size="small" color={c.textMuted} />
            <Text style={styles.muted}>{t('delegates.loading', 'Loading…')}</Text>
          </View>
        ) : summaries.length === 0 ? (
          <Text style={styles.muted}>{t('delegates.nobody', 'Nobody has access to your mail, calendars, contacts or files.')}</Text>
        ) : (
          <View style={styles.list}>
            {summaries.map((summary, index) => {
              const principal = principalFor(summary.principalId);
              const display = principal
                ? principalDisplay(principal)
                : { name: t('delegates.unknown_person', 'Unknown person'), detail: summary.principalId };
              const busy = removingId === summary.principalId;
              return (
                <View key={summary.principalId} style={[styles.row, index > 0 && styles.rowBorder]}>
                  <View style={styles.rowMain}>
                    <SenderAvatar name={principal?.name ?? ''} email={principal?.email ?? ''} size={32} disableImages />
                    <View style={styles.rowText}>
                      <View style={styles.inline}>
                        <Text style={styles.name} numberOfLines={1}>{display.name}</Text>
                        {principal?.type === 'group' && <Text style={styles.groupTag}>{t('delegates.group', 'Group')}</Text>}
                      </View>
                      {display.detail ? <Text style={styles.small} numberOfLines={1}>{display.detail}</Text> : null}
                      <Text style={styles.small}>{describeSummary(summary, t)}</Text>
                    </View>
                  </View>
                  <View style={styles.rowButtons}>
                    <Button variant="outline" size="sm" onPress={() => setDialog({ mode: 'change', summary })} disabled={busy || incomplete}>
                      {t('delegates.change', 'Change')}
                    </Button>
                    <Button variant="outline" size="sm" onPress={() => confirmRemove(summary)} disabled={incomplete} loading={busy}>
                      {t('delegates.remove', 'Remove access')}
                    </Button>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {dialog && targets && (
        <DelegateDialog
          targets={targets}
          directory={directory}
          ownIds={ownIds}
          ownEmails={ownEmails}
          existingIds={new Set(summaries.map((s) => s.principalId))}
          initial={dialog.mode === 'change'
            ? {
                principal: principalFor(dialog.summary.principalId)
                  ?? { id: dialog.summary.principalId, name: t('delegates.unknown_person', 'Unknown person'), type: 'individual' },
                ...changeStartFor(targets, dialog.summary.principalId, levels),
              }
            : undefined}
          levels={levels}
          levelsRestricted={policy.allowedValues !== null && levels.length < 2}
          seenSetsKeywords={sharesSeenWithKeywords()}
          apply={send}
          onApplied={onApplied}
          onClose={() => setDialog(null)}
        />
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    giveRow: { flexDirection: 'row', marginTop: spacing.sm },
    block: { gap: spacing.sm, marginTop: spacing.lg },
    heading: { ...typography.bodyMedium, color: c.text },
    inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
    muted: { ...typography.body, color: c.textMuted },
    small: { ...typography.caption, color: c.textMuted },
    errorSmall: { ...typography.caption, color: c.error, flexShrink: 1 },
    list: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
    row: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    rowMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    name: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
    groupTag: { ...typography.caption, color: c.textMuted, backgroundColor: c.muted, paddingHorizontal: 4, borderRadius: radius.sm },
    rowButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingLeft: 44 },
  });
}
