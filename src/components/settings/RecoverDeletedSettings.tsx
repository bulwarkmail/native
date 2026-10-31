import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CheckSquare, RefreshCw, Square, Undo2 } from '../icons';
import Button from '../Button';
import { SettingsSection } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { usePolicyStore } from '../../stores/policy-store';
import { toast } from '../../stores/toast-store';
import { jmapClient } from '../../api/jmap-client';
import { listArchivedEmails, restoreArchivedItems } from '../../api/archived-items';
import { servedLoginOf } from '../../lib/draft-login';
import { loginMovedFrom } from '../../lib/compose-login';
import { formatListDate } from '../../lib/date-format';
import {
  classifyArchiveError,
  restoreOutcome,
  visibleArchivedItems,
  type ArchivedEmail,
} from '../../lib/recovery/archived-items';
import { recoveryPolicy } from '../../lib/recovery/policy';
import { useRecoveryStore } from '../../lib/recovery/recovery-store';
import { useDeletedItemsRecovery } from '../../lib/recovery/use-deleted-items-recovery';

// Ported from the webmail's components/settings/recover-deleted-settings.tsx
// (#1319): the messages the user deleted for good that Stalwart still keeps
// (Enterprise, `archiveDeletedItemsFor`), newest first, read in pages with
// "Show older" past 2000. Restoring asks the server to put them back in the
// Inbox; it does that in the background, and the mail list picks them up
// from the push that follows. The admin's day limit comes from
// lib/recovery/policy (the active account's organisation policy).

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: ArchivedEmail[]; nextPosition: number | null; loadingOlder: boolean };

interface Outcome {
  restored: number;
  failed: number;
  /** No longer in the archive: restored elsewhere, or the server stopped keeping it. */
  gone: number;
}

const NO_OUTCOME: Outcome = { restored: 0, failed: 0, gone: 0 };

export function RecoverDeletedSettings() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const { available, accountId, key } = useDeletedItemsRecovery();
  const days = usePolicyStore((s) => recoveryPolicy(s.effective).days);
  const record = useRecoveryStore((s) => s.record);
  const forgetRecent = useRecoveryStore((s) => s.forgetRecent);

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(NO_OUTCOME);

  // The account the page shows now: answers for another one are dropped.
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);
  // The login the list was read in: a restore is sent only while it is active.
  const ownerRef = useRef<string | null>(null);
  // An answer that arrives after a newer read started is dropped too.
  const readSeq = useRef(0);

  const refused = useCallback((error: unknown, forKey: string) => {
    // A refusal now (the license ran out) hides the page like detection would.
    if (classifyArchiveError(error) === 'unsupported') record(forKey, 'unsupported');
  }, [record]);

  const load = useCallback(async () => {
    if (!accountId || !key) return;
    const seq = ++readSeq.current;
    ownerRef.current = servedLoginOf(jmapClient);
    setList({ status: 'loading' });
    setSelected(new Set());
    setOutcome(NO_OUTCOME);
    try {
      const result = await listArchivedEmails(accountId, { days });
      if (seq !== readSeq.current) return;
      setList({ status: 'ready', items: result.items, nextPosition: result.nextPosition, loadingOlder: false });
    } catch (error) {
      if (seq !== readSeq.current) return;
      refused(error, key);
      setList({ status: 'error' });
    }
  }, [accountId, key, days, refused]);

  useEffect(() => {
    if (!available) return undefined;
    void load();
    const reads = readSeq;
    return () => {
      reads.current++;
    };
  }, [available, load]);

  const items = useMemo(() => (list.status === 'ready' ? visibleArchivedItems(list.items, days) : []), [list, days]);

  if (!available || !accountId || !key) return null;

  const showOlder = async () => {
    if (list.status !== 'ready' || list.nextPosition === null || list.loadingOlder) return;
    const seq = readSeq.current;
    const start = list.nextPosition;
    setList({ ...list, loadingOlder: true });
    try {
      const result = await listArchivedEmails(accountId, { days, startPosition: start });
      if (seq !== readSeq.current) return;
      setList((prev) => {
        if (prev.status !== 'ready') return prev;
        const known = new Set(prev.items.map((item) => item.id));
        return {
          status: 'ready',
          items: [...prev.items, ...result.items.filter((item) => !known.has(item.id))],
          nextPosition: result.nextPosition,
          loadingOlder: false,
        };
      });
    } catch (error) {
      if (seq !== readSeq.current) return;
      refused(error, key);
      setList((prev) => (prev.status === 'ready' ? { ...prev, loadingOlder: false } : prev));
      toast.error(t('recover_deleted.load_failed', "Deleted mail couldn't be loaded."));
    }
  };

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  const nothingSelected = !items.some((item) => selected.has(item.id));

  const restore = async () => {
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (restoring || ids.length === 0) return;
    const forKey = key;
    const seq = readSeq.current;
    const owner = ownerRef.current;
    setRestoring(true);
    try {
      const results = await restoreArchivedItems(ids, accountId, () => !loginMovedFrom(owner));
      forgetRecent(forKey);
      const { done, gone, failed, refused: unlicensed } = restoreOutcome(ids, results);
      if (unlicensed) record(forKey, 'unsupported');
      // Another account (or a reload of the list) since: none of this applies to what is shown now.
      if (keyRef.current !== forKey || seq !== readSeq.current) return;
      setOutcome({ restored: done.size, failed: failed.length, gone: gone.size });
      // Restored and vanished items leave the list; the ones that failed stay selected to try again.
      setList((prev) => (prev.status === 'ready'
        ? { ...prev, items: prev.items.filter((item) => !done.has(item.id) && !gone.has(item.id)) }
        : prev));
      setSelected(new Set(failed));
      if (done.size > 0) {
        toast.success(t('recover_deleted.restored', '{count, plural, one {# message is} other {# messages are}} on the way back to your Inbox.', { count: done.size }));
      }
      if (failed.length > 0) {
        toast.error(t('recover_deleted.restore_partial', "{count} messages couldn't be restored. They stay selected, so you can try again.", { count: failed.length }));
      }
    } finally {
      setRestoring(false);
    }
  };

  const dateOf = (iso: string | null) => (iso ? formatListDate(iso, { dateFormat: 'full', timeFormat, locale, t }) : '');
  const outcomeLines = [
    outcome.restored > 0
      ? t('recover_deleted.restored', '{count, plural, one {# message is} other {# messages are}} on the way back to your Inbox.', { count: outcome.restored })
      : null,
    outcome.gone > 0
      ? t('recover_deleted.restore_gone', '{count} messages were no longer in the archive: they were restored elsewhere or the server stopped keeping them.', { count: outcome.gone })
      : null,
  ].filter((line): line is string => !!line);

  return (
    <SettingsSection
      title={t('recover_deleted.title', 'Recover deleted items')}
      description={t('recover_deleted.description', 'Mail you deleted for good, for example by emptying Trash, that the server still keeps. Select messages and restore them.')}
    >
      <Text style={styles.muted}>
        {days > 0
          ? t('recover_deleted.range_days', 'Showing mail deleted in the last {days} days.', { days })
          : t('recover_deleted.range_all', 'Showing all deleted mail the server still keeps.')}
      </Text>

      {list.status === 'loading' && (
        <View style={styles.inline} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={c.textMuted} />
          <Text style={styles.muted}>{t('recover_deleted.loading', 'Loading deleted mail…')}</Text>
        </View>
      )}

      {list.status === 'error' && (
        <View style={styles.inline} accessibilityLiveRegion="assertive">
          <Text style={styles.error}>{t('recover_deleted.load_failed', "Deleted mail couldn't be loaded.")}</Text>
          <Button variant="outline" size="sm" onPress={() => void load()}>
            {t('recover_deleted.retry', 'Try again')}
          </Button>
        </View>
      )}

      {list.status === 'ready' && (
        <View style={styles.block}>
          {/* Always there, so what a restore did is read out. */}
          <View accessibilityLiveRegion="polite">
            {outcomeLines.map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
            {outcome.failed > 0 && (
              <Text style={styles.error}>
                {t('recover_deleted.restore_partial', "{count} messages couldn't be restored. They stay selected, so you can try again.", { count: outcome.failed })}
              </Text>
            )}
          </View>

          {items.length === 0 ? (
            <View style={styles.block}>
              <Text style={styles.muted}>{t('recover_deleted.empty', 'There is no deleted mail to recover.')}</Text>
              <Text style={styles.small}>
                {t('recover_deleted.empty_hint', 'Deleted mail only shows up here if your administrator turned on archiving of deleted items in Stalwart.')}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.toolbar}>
                <Pressable
                  onPress={toggleAll}
                  disabled={restoring}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: allSelected, disabled: restoring }}
                  style={styles.selectAll}
                >
                  {allSelected ? <CheckSquare size={20} color={c.primary} /> : <Square size={20} color={c.textMuted} />}
                  <Text style={styles.body}>
                    {selected.size > 0
                      ? t('recover_deleted.selected', '{count} selected', { count: selected.size })
                      : t('recover_deleted.select_all', 'Select all')}
                  </Text>
                </Pressable>
                <View style={styles.toolbarButtons}>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => void load()}
                    disabled={restoring}
                    icon={<RefreshCw size={16} color={c.text} />}
                    accessibilityLabel={t('recover_deleted.refresh', 'Refresh')}
                  />
                  <Button
                    size="sm"
                    onPress={() => void restore()}
                    disabled={nothingSelected}
                    loading={restoring}
                    icon={<Undo2 size={16} color={c.primaryForeground} />}
                  >
                    {t('recover_deleted.restore', 'Restore')}
                  </Button>
                </View>
              </View>

              <View style={styles.list}>
                {items.map((item, index) => {
                  const sender = item.fromName || item.fromEmail || t('recover_deleted.unknown_sender', 'Unknown sender');
                  const checked = selected.has(item.id);
                  const subject = item.subject || t('recover_deleted.no_subject', '(no subject)');
                  const deleted = t('recover_deleted.deleted_on', 'Deleted {date}', { date: dateOf(item.archivedAt) });
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => toggle(item.id)}
                      disabled={restoring}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked, disabled: restoring }}
                      accessibilityLabel={[sender, subject, dateOf(item.receivedAt), deleted].filter(Boolean).join(', ')}
                      style={({ pressed }) => [styles.row, index > 0 && styles.rowBorder, pressed && styles.rowPressed]}
                    >
                      {checked ? <CheckSquare size={20} color={c.primary} /> : <Square size={20} color={c.textMuted} />}
                      <View style={styles.rowText}>
                        <View style={styles.rowTop}>
                          <Text style={styles.sender} numberOfLines={1}>{sender}</Text>
                          {item.receivedAt ? <Text style={styles.small}>{dateOf(item.receivedAt)}</Text> : null}
                        </View>
                        <Text style={styles.body} numberOfLines={1}>{subject}</Text>
                        <Text style={styles.small}>{deleted}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.small}>
                {t('recover_deleted.restore_hint', "Restored mail goes back to your Inbox as unread, sorted by its original date, so it may be far down the list. The server restores it in the background. If that fails there, the message is lost and Bulwark can't tell.")}
              </Text>
            </>
          )}

          {list.nextPosition !== null && (
            <Button variant="outline" size="sm" onPress={() => void showOlder()} loading={list.loadingOlder} style={styles.olderButton}>
              {t('recover_deleted.show_older', 'Show older')}
            </Button>
          )}
        </View>
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: { gap: spacing.sm, marginTop: spacing.sm },
    inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
    muted: { ...typography.body, color: c.textMuted },
    small: { fontSize: 12, lineHeight: 16, color: c.textMuted },
    error: { ...typography.body, color: c.error },
    body: { ...typography.body, color: c.text },
    toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
    selectAll: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingRight: spacing.sm },
    toolbarButtons: { flexDirection: 'row', gap: spacing.sm, marginLeft: 'auto' },
    list: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    rowPressed: { backgroundColor: c.muted },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
    sender: { ...typography.bodyMedium, color: c.text, flex: 1 },
    olderButton: { alignSelf: 'flex-start' },
  });
}
