import React from 'react';
import { ArrowRight, Ban, MailOpen, Plus, Tag } from '../icons';
import { ActionSheet, type ActionSheetItem } from '../email/ActionSheet';
import { MoveSheet } from '../MoveSheet';
import { FilterRuleModal } from './FilterRuleModal';
import type { Email, Mailbox } from '../../api/types';
import { getSieveAccountId, getSieveCapabilities } from '../../api/sieve';
import { FiltersLoginChangedError, OpaqueFiltersError, readAccountFilters, updateAccountFilters } from '../../api/sieve-rules';
import { forwardsAround, inRunOrder } from '../../lib/sieve/forward-limit';
import { jmapClient } from '../../api/jmap-client';
import { servedLoginOf } from '../../lib/draft-login';
import { supportsPeriods } from '../../lib/sieve/period';
import {
  applyQuickRule,
  buildPrefillRule,
  buildPresetRule,
  findJunkMailbox,
  insertRuleAtTop,
  normalizeAddress,
  quickRuleSubject,
  ruleTargetMailboxes,
  toRuleMailbox,
  type QuickRuleOutcome,
  type QuickRulePreset,
} from '../../lib/sieve/quick-rules';
import type { FilterRule } from '../../lib/sieve/types';
import { generateUUID } from '../../lib/uuid';
import { useAccountStore } from '../../stores/account-store';
import { useFilterStore } from '../../stores/filter-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { toast } from '../../stores/toast-store';
import { useColors } from '../../theme/colors';

type Step =
  | { kind: 'menu' }
  | { kind: 'folder'; preset: 'move_sender' | 'move_domain' | 'move_list' }
  | { kind: 'tag' }
  | { kind: 'editor'; rule: FilterRule };

interface QuickRuleSheetProps {
  visible: boolean;
  /** The message the rule is made from; it belongs to the user's own account. */
  email: Email | null;
  /** The own account's folders. */
  mailboxes: Mailbox[];
  onClose: () => void;
}

/**
 * "Rules" on a message (webmail components/email/rules-menu.tsx): one tap
 * makes a rule from its sender, the sender's domain or its List-Id, or opens
 * the rule editor prefilled. The rule goes to the top of the account's
 * filters, or into an existing rule that does the same for other senders.
 */
export function QuickRuleSheet({ visible, email, mailboxes, onClose }: QuickRuleSheetProps) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const identities = useSettingsStore((s) => s.identities);
  const keywords = useKeywordsStore((s) => s.keywords);
  const [step, setStep] = React.useState<Step>({ kind: 'menu' });
  // The login and Sieve account the sheet opened in. The rule is built from
  // that login's message and folders; after a switch it must not go into the
  // other login, where the same ids name other folders.
  const openedIn = React.useRef<{ login: string | null; accountId: string | null }>({ login: null, accountId: null });

  React.useEffect(() => {
    if (!visible) return;
    setStep({ kind: 'menu' });
    let accountId: string | null = null;
    try { accountId = getSieveAccountId(); } catch { /* not connected yet */ }
    // Not connected yet (a cold start), the cached message is the active
    // login's.
    const login = servedLoginOf(jmapClient) ?? useAccountStore.getState().activeAccountId;
    openedIn.current = { login, accountId };
  }, [visible]);

  const ownAddresses = React.useMemo(
    () => new Set(identities.map((i) => normalizeAddress(i.email))),
    [identities],
  );
  const subject = React.useMemo(
    () => quickRuleSubject(email ? [email] : [], ownAddresses),
    [email, ownAddresses],
  );
  const targets = React.useMemo(() => ruleTargetMailboxes(mailboxes), [mailboxes]);
  const junk = React.useMemo(() => findJunkMailbox(mailboxes), [mailboxes]);
  const periodsSupported = supportsPeriods(getSieveCapabilities()?.sieveExtensions);

  // Where the new rule runs among the account's rules, for the server's
  // redirect limit: at the top, behind the out of office forwarding
  // (webmail quick-rule-host.tsx; lib/sieve/forward-limit.ts).
  const editorOpen = visible && step.kind === 'editor';
  const [forwards, setForwards] = React.useState({ before: 0, after: 0 });
  React.useEffect(() => {
    setForwards({ before: 0, after: 0 });
    if (!editorOpen) return;
    let current = true;
    const accountId = openedIn.current.accountId ?? undefined;
    readAccountFilters(accountId)
      .then((parsed) => {
        if (!current || parsed.isOpaque) return;
        const runOrder = inRunOrder(parsed.rules, parsed.vacationForward);
        setForwards(forwardsAround(runOrder, runOrder.length - parsed.rules.length, false));
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [editorOpen]);

  const [sender] = subject.senders;
  const senderLabel = subject.senders.length === 1
    ? (sender.name || sender.email)
    : t('context_menu.rules.senders_count', '{count, plural, one {# sender} other {# senders}}', { count: subject.senders.length });

  const finish = () => {
    setStep({ kind: 'menu' });
    onClose();
  };

  /** Write `modify`'s rules into the own account's script and say how it went. */
  const write = async (modify: (rules: FilterRule[]) => FilterRule[] | null) => {
    const { login } = openedIn.current;
    let accountId = openedIn.current.accountId;
    try {
      // Read now only when the sheet opened before the session was up;
      // updateAccountFilters refuses it unless the login is still the same.
      accountId ??= getSieveAccountId();
      await updateAccountFilters(modify, accountId, login);
    } catch (err) {
      if (err instanceof FiltersLoginChangedError) {
        toast.error(t('context_menu.rules.login_changed', 'You switched accounts, so the rule was not saved'));
      } else if (err instanceof OpaqueFiltersError) {
        toast.error(t('context_menu.rules.opaque_hint', 'Your filters were edited by hand. Open Filters settings'));
      } else {
        toast.error(t('notifications.filters_save_failed', 'Failed to save filters'), err instanceof Error ? err.message : undefined);
      }
      return false;
    }
    // The Filters settings show what was written when they show this account.
    const store = useFilterStore.getState();
    if (store.selectedAccountId === accountId) void store.fetchFilters(accountId);
    return true;
  };

  const savePreset = async (preset: QuickRulePreset) => {
    finish();
    const candidate = buildPresetRule(preset, subject, t, generateUUID());
    let outcome: QuickRuleOutcome | null = null;
    const ok = await write((rules) => {
      outcome = applyQuickRule(rules, candidate);
      return outcome.kind === 'covered' ? null : outcome.rules;
    });
    if (!ok || !outcome) return;
    const result = outcome as QuickRuleOutcome;
    if (result.kind === 'covered') {
      toast.info(t('notifications.rule_already_covered', 'Already covered by rule “{name}”', { name: result.rule.name }));
    } else if (result.kind === 'merged') {
      toast.success(t('notifications.rule_merged', 'Added to rule “{name}”', { name: result.rule.name }));
    } else {
      toast.success(t('notifications.rule_created', 'Rule created'), result.rule.name);
    }
  };

  const saveEditorRule = async (rule: FilterRule) => {
    finish();
    // As built in the editor: at the top, never merged into another rule.
    if (await write((rules) => insertRuleAtTop(rules, rule))) {
      toast.success(t('notifications.rule_created', 'Rule created'), rule.name);
    }
  };

  const items: ActionSheetItem[] = [];
  if (subject.senders.length > 0) {
    items.push({
      key: 'move_sender',
      label: t('context_menu.rules.move_from', 'Always move messages from {sender}', { sender: senderLabel }),
      icon: <ArrowRight size={18} color={c.textSecondary} />,
      onPress: () => setStep({ kind: 'folder', preset: 'move_sender' }),
    });
  }
  if (subject.domain) {
    items.push({
      key: 'move_domain',
      label: t('context_menu.rules.move_from_domain', 'Always move messages from @{domain}', { domain: subject.domain }),
      icon: <ArrowRight size={18} color={c.textSecondary} />,
      onPress: () => setStep({ kind: 'folder', preset: 'move_domain' }),
    });
  }
  if (subject.listId) {
    items.push({
      key: 'move_list',
      label: t('context_menu.rules.move_from_list', 'Always move messages from this list'),
      icon: <ArrowRight size={18} color={c.textSecondary} />,
      onPress: () => setStep({ kind: 'folder', preset: 'move_list' }),
    });
  }
  if (subject.senders.length > 0) {
    items.push({
      key: 'mark_read',
      label: t('context_menu.rules.mark_read_from', 'Always mark as read from {sender}', { sender: senderLabel }),
      icon: <MailOpen size={18} color={c.textSecondary} />,
      onPress: () => void savePreset({ kind: 'mark_read' }),
    });
    if (keywords.length > 0) {
      items.push({
        key: 'tag',
        label: t('context_menu.rules.tag_with', 'Always tag with'),
        icon: <Tag size={18} color={c.textSecondary} />,
        onPress: () => setStep({ kind: 'tag' }),
      });
    }
    items.push({
      key: 'block',
      label: junk
        ? t('context_menu.rules.block', '{count, plural, one {Block sender} other {Block # senders}}', { count: subject.senders.length })
        : t('context_menu.rules.no_junk', 'This account has no Junk folder'),
      icon: <Ban size={18} color={junk ? c.error : c.textMuted} />,
      destructive: !!junk,
      disabled: !junk,
      onPress: () => { if (junk) void savePreset({ kind: 'block', junk: toRuleMailbox(mailboxes, junk) }); },
    });
  }
  items.push({
    key: 'create',
    label: t('context_menu.rules.create', 'Create rule…'),
    icon: <Plus size={18} color={c.textSecondary} />,
    onPress: () => setStep({ kind: 'editor', rule: buildPrefillRule(subject, t, generateUUID()) }),
  });

  const tagItems: ActionSheetItem[] = keywords.map((kw) => ({
    key: kw.id,
    label: kw.label,
    icon: <Tag size={18} color={c.textSecondary} />,
    onPress: () => void savePreset({ kind: 'tag', tagId: kw.id, tagName: kw.label }),
  }));

  const pickFolder = (id: string) => {
    if (step.kind !== 'folder') return;
    const mailbox = mailboxes.find((m) => m.id === id);
    if (!mailbox) return;
    void savePreset({ kind: step.preset, mailbox: toRuleMailbox(mailboxes, mailbox) });
  };

  return (
    <>
      <ActionSheet
        visible={visible && step.kind === 'menu'}
        title={t('context_menu.rules.title', 'Rules')}
        subtitle={subject.senders.map((s) => s.email).join(', ') || undefined}
        items={items}
        onClose={finish}
      />
      <MoveSheet
        visible={visible && step.kind === 'folder'}
        onClose={() => setStep({ kind: 'menu' })}
        mailboxes={targets}
        currentMailboxId={null}
        onPick={pickFolder}
      />
      <ActionSheet
        visible={visible && step.kind === 'tag'}
        title={t('context_menu.rules.tag_with', 'Always tag with')}
        items={tagItems}
        onClose={() => setStep({ kind: 'menu' })}
      />
      <FilterRuleModal
        visible={visible && step.kind === 'editor'}
        initialRule={step.kind === 'editor' ? step.rule : undefined}
        mailboxes={mailboxes}
        periodsSupported={periodsSupported}
        forwardContext={{
          maxRedirects: getSieveCapabilities(openedIn.current.accountId ?? undefined)?.maxNumberRedirects,
          ...forwards,
        }}
        onSave={(rule) => void saveEditorRule(rule)}
        onClose={finish}
      />
    </>
  );
}

