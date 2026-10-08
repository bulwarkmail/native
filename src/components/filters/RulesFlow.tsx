import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  Ban, FolderInput, List as ListIcon, MailOpen, Plus, Settings as SettingsIcon, Tag as TagIcon,
} from 'lucide-react-native';
import { ActionSheet, type ActionSheetItem } from '../email/ActionSheet';
import { MoveSheet } from '../MoveSheet';
import { FilterRuleModal } from './FilterRuleModal';
import { useColors } from '../../theme/colors';
import { spacing, typography } from '../../theme/tokens';
import { useLocaleStore, t as translateNow } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import { useAccountStore } from '../../stores/account-store';
import { useManagedAccountStore } from '../../stores/managed-account-store';
import { fetchListIds } from '../../api/list-ids';
import { readAccountFilters } from '../../lib/filters/account-filters';
import { forwardsForRule } from '../../lib/filters/forward-limit-view';
import { supportsPeriods } from '../../lib/sieve/period';
import {
  buildPrefillRule,
  buildSuggestions,
  collectSenders,
  extractListId,
  findJunkMailbox,
  headerValue,
  normalizeAddress,
  ruleTargetMailboxIds,
  rulesMenuAvailability,
  sharedDomain,
  sharedListId,
  toRuleMailbox,
  unfoldHeader,
  type QuickRuleSubject,
  type RuleSuggestion,
  type RulesMenuAvailability,
  type Translate,
} from '../../lib/filters/quick-rules';
import { resolveQuickRuleTarget, type QuickRuleTarget } from '../../lib/filters/quick-rule-target';
import { runPresetRule, saveEditorRule, targetStillActive } from '../../lib/filters/quick-rule-flow';
import {
  NO_JUNK_HINT_KEY,
  rulesSheetItems,
  targetFiltersFor,
  type RulesSheetItem,
  type RulesSheetItemId,
  type TargetFilters,
} from '../../lib/filters/rules-sheet';
import { setPendingSettingsTab } from '../../navigation/pending-settings-tab';
import { generateUUID } from '../../lib/uuid';
import type { Email } from '../../api/types';
import type { FilterRule } from '../../lib/sieve/types';

/**
 * The Rules sheet of the message viewer's More menu and of the list's
 * selection bar: one-tap rules for the sender(s), "Create rule…" and "Manage
 * rules". The account is the messages' own (resolveQuickRuleTarget); nothing
 * here reads the filter store or the client's default account.
 */

const filtersText: Translate = (key, values) => translateNow(`settings.filters.${key}`, undefined, values);

function truncate(value: string, max = 36): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface RulesTargetOptions {
  /** The viewer passes its message's account (undefined = the user's own). */
  fromViewer?: boolean;
  viewedAccountId?: string;
}

/** Whether `emails` get a Rules entry, and for which account. */
export function useRulesTarget(
  emails: Email[],
  { fromViewer, viewedAccountId }: RulesTargetOptions = {},
): { availability: RulesMenuAvailability; target: QuickRuleTarget | null } {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  return React.useMemo(() => {
    const targets = emails.map((email) =>
      resolveQuickRuleTarget(email, fromViewer ? { viewedAccountId } : {}));
    const availability = rulesMenuAvailability(
      targets.map((tg) => tg && { key: tg.key, shared: tg.shared, supportsSieve: tg.supportsSieve }),
    );
    return { availability, target: availability === 'available' ? targets[0] : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emails, fromViewer, viewedAccountId, activeAccountId]);
}

type View_ = 'root' | 'move_sender' | 'move_domain' | 'move_list' | 'tag' | 'editor';
type MoveKind = 'move_sender' | 'move_domain' | 'move_list';

interface EditorState {
  rule: FilterRule;
  suggestions: RuleSuggestion[];
}

interface RulesFlowProps {
  visible: boolean;
  onClose: () => void;
  /** The message, or the selection. The first is the one "apply to existing" runs from. */
  emails: Email[];
  fromViewer?: boolean;
  viewedAccountId?: string;
}

export function RulesFlow({ visible, onClose, emails, fromViewer, viewedAccountId }: RulesFlowProps) {
  const { availability, target } = useRulesTarget(emails, { fromViewer, viewedAccountId });
  if (!visible || availability === 'hidden') return null;
  return (
    <RulesFlowBody
      key={emails.map((e) => e.id).join(',')}
      availability={availability}
      target={target}
      emails={emails}
      onClose={onClose}
    />
  );
}

function RulesFlowBody({
  availability, target, emails, onClose,
}: {
  availability: RulesMenuAvailability;
  target: QuickRuleTarget | null;
  emails: Email[];
  onClose: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(makeStyles, [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<any>();
  const [view, setView] = React.useState<View_>('root');
  const [editor, setEditor] = React.useState<EditorState | null>(null);

  const identities = useSettingsStore((s) => s.identities);
  const ensureIdentities = useSettingsStore((s) => s.ensureIdentities);
  const keywords = useKeywordsStore((s) => s.keywords);
  React.useEffect(() => { void ensureIdentities(); }, [ensureIdentities]);
  const own = React.useMemo(
    () => new Set(identities.map((i) => normalizeAddress(i.email)).filter(Boolean)),
    [identities],
  );

  const senders = React.useMemo(() => collectSenders(emails, own), [emails, own]);

  // The viewer's message carries its headers; list rows do not, so their
  // List-Id is asked for once the sheet opens.
  const [fetched, setFetched] = React.useState<Map<string, string | null>>(() => new Map());
  const jmapAccountId = target?.jmapAccountId;
  React.useEffect(() => {
    if (!jmapAccountId) return;
    const missing = emails.filter((e) => !e.headers).map((e) => e.id);
    if (missing.length === 0) return;
    let cancelled = false;
    fetchListIds(missing, jmapAccountId)
      .then((found) => { if (!cancelled) setFetched(found); })
      .catch(() => { /* no list preset then */ });
    return () => { cancelled = true; };
  }, [emails, jmapAccountId]);
  const listId = React.useMemo(() => sharedListId(emails.map((e) =>
    (e.headers
      ? extractListId(unfoldHeader(headerValue(e.headers, 'List-Id')))
      : fetched.get(e.id) ?? null))), [emails, fetched]);

  const subject: QuickRuleSubject = React.useMemo(
    () => ({ senders, domain: sharedDomain(senders), listId }),
    [senders, listId],
  );

  // Whether the account's script can take a rule, and the forwards around a
  // new rule for the server's redirect limit ("Create rule…" puts it first,
  // behind the out of office forwarding): asked of the server for this
  // account, not read from the filter store. Kept with the target it was read
  // for (its key names the login too: Sieve ids repeat across logins), and
  // used only while that is still the target. Unknown counts as open: a write
  // on a hand-edited script reports it.
  const sieveAccountId = target?.sieveAccountId;
  const targetKey = target?.key;
  const [read, setRead] = React.useState<TargetFilters | null>(null);
  React.useEffect(() => {
    setRead(null);
    if (!sieveAccountId || !targetKey) return;
    let cancelled = false;
    readAccountFilters(sieveAccountId)
      .then((filters) => {
        if (cancelled) return;
        setRead({
          targetKey,
          opaque: filters.parsed.isOpaque,
          forwards: filters.parsed.isOpaque ? null : {
            maxRedirects: filters.capabilities?.maxNumberRedirects ?? null,
            periodsSupported: supportsPeriods(filters.capabilities?.sieveExtensions),
            ...forwardsForRule(filters.parsed.rules, filters.parsed.vacationForward, undefined, 0),
          },
        });
      })
      .catch(() => { /* the write reports it */ });
    return () => { cancelled = true; };
  }, [sieveAccountId, targetKey]);
  const shownRead = targetFiltersFor(read, targetKey);
  const opaque = shownRead?.opaque ?? false;
  const forwards = shownRead?.forwards ?? null;

  const mailboxes = target?.mailboxes;
  const junk = React.useMemo(() => (mailboxes ? findJunkMailbox(mailboxes) : undefined), [mailboxes]);
  const targetMailboxes = React.useMemo(() => {
    if (!mailboxes) return [];
    const ids = ruleTargetMailboxIds(mailboxes);
    return mailboxes.filter((m) => ids.has(m.id));
  }, [mailboxes]);

  const items = rulesSheetItems({
    availability,
    senders,
    domain: subject.domain,
    listId,
    hasJunk: !!junk,
    hasTags: keywords.length > 0,
    opaque,
  });

  const senderLabel = senders.length === 1
    ? truncate(senders[0].name || senders[0].email)
    : t('context_menu.rules.senders_count', '{count, plural, one {# sender} other {# senders}}', { count: senders.length });

  const live = (): QuickRuleTarget | null => {
    if (!target || !targetStillActive(target)) {
      onClose();
      return null;
    }
    return target;
  };

  const runMove = (kind: MoveKind, mailboxId: string) => {
    const tg = live();
    const mailbox = tg?.mailboxes.find((m) => m.id === mailboxId);
    if (!tg || !mailbox) return;
    onClose();
    void runPresetRule({ target: tg, preset: { kind, mailbox: toRuleMailbox(tg.mailboxes, mailbox) }, subject });
  };

  const openEditor = () => {
    if (!live()) return;
    // The first message's subject and delivery address are what the chips
    // offer. A fresh rule (and id) per open: the modal re-seeds when this changes.
    const source = emails[0];
    setEditor({
      rule: buildPrefillRule(subject, filtersText, generateUUID()),
      suggestions: buildSuggestions(source, subject, own, filtersText),
    });
    setView('editor');
  };

  const manage = () => {
    onClose();
    // Only the user's own account has rules here, so Settings is unscoped.
    useManagedAccountStore.getState().clear();
    setPendingSettingsTab('filters');
    navigation.navigate('MainTabs', { screen: 'Settings' });
  };

  const labels: Record<RulesSheetItemId, string> = {
    move_sender: t('context_menu.rules.move_from', 'Always move messages from {sender}', { sender: senderLabel }),
    move_domain: t('context_menu.rules.move_from_domain', 'Always move messages from @{domain}', { domain: subject.domain ?? '' }),
    move_list: t('context_menu.rules.move_from_list', 'Always move messages from this list'),
    mark_read: t('context_menu.rules.mark_read_from', 'Always mark as read from {sender}', { sender: senderLabel }),
    tag: t('context_menu.rules.tag_with', 'Always tag with'),
    block: t(
      'context_menu.rules.block',
      '{count, plural, one {Block sender} other {Block # senders}}',
      { count: senders.length },
    ),
    create: t('context_menu.rules.create', 'Create rule…'),
    manage: t('context_menu.rules.manage', 'Manage rules'),
  };
  const icons: Record<RulesSheetItemId, React.ReactNode> = {
    move_sender: <FolderInput size={18} color={c.textSecondary} />,
    move_domain: <FolderInput size={18} color={c.textSecondary} />,
    move_list: <ListIcon size={18} color={c.textSecondary} />,
    mark_read: <MailOpen size={18} color={c.textSecondary} />,
    tag: <TagIcon size={18} color={c.textSecondary} />,
    block: <Ban size={18} color={c.error} />,
    create: <Plus size={18} color={c.textSecondary} />,
    manage: <SettingsIcon size={18} color={c.textSecondary} />,
  };
  const press: Record<RulesSheetItemId, () => void> = {
    move_sender: () => setView('move_sender'),
    move_domain: () => setView('move_domain'),
    move_list: () => setView('move_list'),
    mark_read: () => {
      const tg = live();
      if (!tg) return;
      onClose();
      void runPresetRule({ target: tg, preset: { kind: 'mark_read' }, subject });
    },
    tag: () => setView('tag'),
    block: () => {
      const tg = live();
      const junkBox = tg?.mailboxes.find((m) => m.id === junk?.id);
      if (!tg || !junkBox) return;
      onClose();
      void runPresetRule({ target: tg, preset: { kind: 'block', junk: toRuleMailbox(tg.mailboxes, junkBox) }, subject });
    },
    create: openEditor,
    manage,
  };

  // Only Block's own reason is shown on its row; the sheet-wide reasons
  // (opaque, cross account) are the subtitle.
  const rowHint = (item: RulesSheetItem): React.ReactNode => (
    item.hint === NO_JUNK_HINT_KEY
      ? (
        <Text style={[styles.hint, { color: c.textMuted }]}>
          {t('context_menu.rules.no_junk', 'This account has no Junk folder')}
        </Text>
      )
      : undefined
  );
  const sheetItems: ActionSheetItem[] = items.map((item) => ({
    key: item.id,
    label: labels[item.id],
    icon: icons[item.id],
    destructive: item.id === 'block',
    disabled: item.disabled,
    trailing: rowHint(item),
    onPress: press[item.id],
  }));
  // One line for the whole sheet when every item shares the reason.
  const subtitle = availability === 'cross_account'
    ? t('context_menu.rules.cross_account', 'Select messages from one account')
    : opaque
      ? t('context_menu.rules.opaque_hint', 'Your filters were edited by hand. Open Filters settings')
      : undefined;

  const back = () => setView('root');
  const moveKind: MoveKind | null = view === 'move_sender' || view === 'move_domain' || view === 'move_list' ? view : null;
  const moveTitle = moveKind ? labels[moveKind] : '';

  const tagItems: ActionSheetItem[] = keywords.map((kw) => ({
    key: kw.id,
    label: kw.label,
    icon: <View style={[styles.dot, { backgroundColor: c.tags[kw.color]?.dot }]} />,
    onPress: () => {
      const tg = live();
      if (!tg) return;
      onClose();
      void runPresetRule({ target: tg, preset: { kind: 'tag', tagId: kw.id, tagName: kw.label }, subject });
    },
  }));

  return (
    <>
      <ActionSheet
        visible={view === 'root'}
        title={t('context_menu.rules.title', 'Rules')}
        subtitle={subtitle}
        items={sheetItems}
        onClose={onClose}
      />
      <MoveSheet
        visible={moveKind !== null}
        title={moveTitle}
        mailboxes={targetMailboxes}
        currentMailboxId={null}
        onPick={(id) => { if (moveKind) runMove(moveKind, id); }}
        onClose={back}
      />
      <ActionSheet
        visible={view === 'tag'}
        title={labels.tag}
        items={tagItems}
        onClose={back}
      />
      {target && editor && (
        <FilterRuleModal
          visible={view === 'editor'}
          initialRule={editor.rule}
          suggestions={editor.suggestions}
          offerApplyToExisting={!!target.sourceMailboxId}
          mailboxes={target.mailboxes}
          maxRedirects={forwards?.maxRedirects}
          forwardsBefore={forwards?.before}
          forwardsAfter={forwards?.after}
          periodsSupported={forwards?.periodsSupported}
          onSave={(rule, options) => {
            const tg = live();
            if (!tg) return;
            onClose();
            void saveEditorRule(rule, { target: tg, applyToExisting: options?.applyToExisting, mode: 'create' });
          }}
          onClose={onClose}
        />
      )}
    </>
  );
}

// Built per palette, so the hint follows the font size setting.
const makeStyles = () => StyleSheet.create({
  hint: { ...typography.caption, flexShrink: 1, textAlign: 'right', maxWidth: 140, marginLeft: spacing.sm },
  dot: { width: 18, height: 18, borderRadius: 9 },
});
