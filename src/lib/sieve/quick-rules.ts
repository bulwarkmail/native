import type { Email, Mailbox } from '../../api/types';
import type { FilterAction, FilterCondition, FilterRule } from './types';
import { hasPeriod } from './period';

// Rules made from a message (webmail lib/filters/quick-rules.ts): "Always move
// messages from Anna to...", "Block sender", and the rule "Create rule..."
// opens with. Pure functions; the account plumbing is in api/sieve-rules.ts.

export interface RuleSender {
  /** Lower-cased address. */
  email: string;
  name?: string;
}

/** A folder a rule files into: the JMAP id plus the Sieve path fallback. */
export interface RuleMailbox {
  id: string;
  path: string;
  name: string;
}

export type QuickRulePreset =
  | { kind: 'move_sender'; mailbox: RuleMailbox }
  | { kind: 'move_domain'; mailbox: RuleMailbox }
  | { kind: 'move_list'; mailbox: RuleMailbox }
  | { kind: 'mark_read' }
  | { kind: 'tag'; tagId: string; tagName: string }
  | { kind: 'block'; junk: RuleMailbox };

/** What the presets are made from. */
export interface QuickRuleSubject {
  senders: RuleSender[];
  /** The one domain every sender shares. */
  domain: string | null;
  /** The one List-Id every message carries. */
  listId: string | null;
}

/** The settings.filters translator, as the rule names use it. */
export type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export function normalizeAddress(address: string | null | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/**
 * Every distinct sender of `emails`, compared case-insensitively, with the
 * first display name seen for each. The user's own addresses are dropped: a
 * rule against yourself would file your own replies away.
 */
export function collectSenders(emails: Array<Pick<Email, 'from'>>, ownAddresses: ReadonlySet<string>): RuleSender[] {
  const byAddress = new Map<string, RuleSender>();
  for (const email of emails) {
    for (const from of email.from ?? []) {
      const address = normalizeAddress(from.email);
      if (!address || !address.includes('@') || ownAddresses.has(address)) continue;
      const existing = byAddress.get(address);
      const name = from.name?.trim() || undefined;
      if (!existing) byAddress.set(address, { email: address, ...(name ? { name } : {}) });
      else if (!existing.name && name) existing.name = name;
    }
  }
  return [...byAddress.values()];
}

/** The domain every sender shares, or null when they differ (or there are none). */
export function sharedDomain(senders: RuleSender[]): string | null {
  let domain: string | null = null;
  for (const sender of senders) {
    const d = addressDomain(sender.email);
    if (!d) return null;
    if (domain === null) domain = d;
    else if (d !== domain) return null;
  }
  return domain;
}

/**
 * The list identifier of a List-Id header (RFC 2919): the part inside the
 * angle brackets, so "Weekly news <news.example.org>" gives
 * "news.example.org". A header without brackets is taken whole.
 */
export function extractListId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ').trim();
  const bracketed = unfolded.match(/<([^<>]+)>\s*$/);
  const id = (bracketed ? bracketed[1] : unfolded).trim();
  if (!id || /\s/.test(id)) return null;
  return id;
}

/** The List-Id of a message, from its raw header list. */
export function emailListId(email: Pick<Email, 'headers'>): string | null {
  const header = email.headers?.find((h) => h.name.toLowerCase() === 'list-id');
  return header ? extractListId(header.value) : null;
}

/** What the presets for `emails` are made from. */
export function quickRuleSubject(
  emails: Array<Pick<Email, 'from' | 'headers'>>,
  ownAddresses: ReadonlySet<string>,
): QuickRuleSubject {
  const senders = collectSenders(emails, ownAddresses);
  return { senders, domain: sharedDomain(senders), listId: sharedListId(emails.map(emailListId)) };
}

/** The List-Id every message has, or null when one lacks it or they differ. */
export function sharedListId(listIds: Array<string | null | undefined>): string | null {
  let shared: string | null = null;
  for (const id of listIds) {
    if (!id) return null;
    if (shared === null) shared = id;
    else if (shared.toLowerCase() !== id.toLowerCase()) return null;
  }
  return shared;
}

/**
 * The Sieve path of a folder, as the rule editor writes it: parent names
 * joined with "/", with the inbox as the IMAP-canonical "INBOX".
 */
export function mailboxSievePath(mailboxes: Mailbox[], mailboxId: string): string {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(mailboxId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    segments.unshift(current.role === 'inbox' ? 'INBOX' : current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return segments.join('/');
}

export function toRuleMailbox(mailboxes: Mailbox[], mailbox: Mailbox): RuleMailbox {
  return { id: mailbox.originalId || mailbox.id, path: mailboxSievePath(mailboxes, mailbox.id), name: mailbox.name };
}

/**
 * Folders an "Always move" rule can file into: the account's own folders
 * that accept mail, without Drafts. Unlike "Move to", the current folder and
 * the Inbox stay in.
 */
export function ruleTargetMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.filter((m) =>
    !m.isShared && !m.id.startsWith('shared-') && m.role !== 'drafts' && m.myRights?.mayAddItems !== false);
}

export function findJunkMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  return mailboxes.find((m) => !m.isShared && m.role === 'junk');
}

function senderValue(senders: RuleSender[]): string | string[] {
  const addresses = senders.map((s) => s.email);
  return addresses.length === 1 ? addresses[0] : addresses;
}

/** The condition "from one of these senders", matched on the exact address. */
export function senderCondition(senders: RuleSender[]): FilterCondition {
  return { field: 'from', comparator: 'address_is', value: senderValue(senders) };
}

export function domainCondition(domain: string): FilterCondition {
  return { field: 'from', comparator: 'domain_is', value: domain };
}

export function listIdCondition(listId: string): FilterCondition {
  return { field: 'header', headerName: 'List-Id', comparator: 'contains', value: listId };
}

/** How rule names refer to the senders: the address, or "3 senders". */
export function senderNameFor(senders: RuleSender[], t: Translate): string {
  return senders.length === 1
    ? senders[0].email
    : t('settings.filters.quick_rule_names.senders', '{count, plural, one {# sender} other {# senders}}', { count: senders.length });
}

function moveAction(mailbox: RuleMailbox): FilterAction {
  return { type: 'move', value: mailbox.path, mailboxId: mailbox.id };
}

/** The rule a one-click preset saves, named for what it does. */
export function buildPresetRule(
  preset: QuickRulePreset,
  subject: QuickRuleSubject,
  t: Translate,
  id: string,
): FilterRule {
  const sender = senderNameFor(subject.senders, t);
  const base = { id, enabled: true, matchType: 'all' as const, stopProcessing: true };
  switch (preset.kind) {
    case 'move_sender':
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.move_sender', 'Move from {sender} to {folder}', { sender, folder: preset.mailbox.name }),
        conditions: [senderCondition(subject.senders)],
        actions: [moveAction(preset.mailbox)],
      };
    case 'move_domain':
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.move_domain', 'Move from @{domain} to {folder}', { domain: subject.domain ?? '', folder: preset.mailbox.name }),
        conditions: [domainCondition(subject.domain ?? '')],
        actions: [moveAction(preset.mailbox)],
      };
    case 'move_list':
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.move_list', 'Move list {list} to {folder}', { list: subject.listId ?? '', folder: preset.mailbox.name }),
        conditions: [listIdCondition(subject.listId ?? '')],
        actions: [moveAction(preset.mailbox)],
      };
    case 'mark_read':
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.mark_read', 'Mark as read from {sender}', { sender }),
        conditions: [senderCondition(subject.senders)],
        actions: [{ type: 'mark_read' }],
      };
    case 'tag':
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.tag', 'Tag as {tag} from {sender}', { sender, tag: preset.tagName }),
        conditions: [senderCondition(subject.senders)],
        actions: [{ type: 'add_label', value: preset.tagId }],
      };
    case 'block':
      // The spam guard would skip exactly the mail this rule is for.
      return {
        ...base,
        name: t('settings.filters.quick_rule_names.block', 'Block {sender}', { sender }),
        conditions: [senderCondition(subject.senders)],
        actions: [moveAction(preset.junk)],
        includeSpam: true,
      };
  }
}

/**
 * The rule "Create rule..." opens with: From = the senders, one Move with no
 * folder chosen yet, stop after it.
 */
export function buildPrefillRule(subject: QuickRuleSubject, t: Translate, id: string): FilterRule {
  const hasSenders = subject.senders.length > 0;
  return {
    id,
    name: hasSenders
      ? t('settings.filters.quick_rule_names.custom', 'Mail from {sender}', { sender: senderNameFor(subject.senders, t) })
      : t('settings.filters.quick_rule_names.custom_plain', 'New rule'),
    enabled: true,
    matchType: 'all',
    conditions: hasSenders ? [senderCondition(subject.senders)] : [],
    actions: [{ type: 'move', value: '' }],
    stopProcessing: true,
  };
}

export function isBulwarkRule(rule: FilterRule): boolean {
  return !rule.origin || rule.origin === 'bulwark';
}

/**
 * New rules made from a message go first, so an older, broader rule does not
 * catch the mail before them. The generator writes the vacation block and the
 * external/opaque blocks where they always go, so the front of the list is
 * the top of Bulwark's own section.
 */
export function insertRuleAtTop(rules: FilterRule[], rule: FilterRule): FilterRule[] {
  return [rule, ...rules];
}

/** Replace the rule with the same id in place, or add it at the top. */
export function replaceOrInsertRule(rules: FilterRule[], rule: FilterRule): FilterRule[] {
  return rules.some((r) => r.id === rule.id)
    ? rules.map((r) => (r.id === rule.id ? rule : r))
    : insertRuleAtTop(rules, rule);
}

function valueList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.length > 0);
}

function sameConditionKind(a: FilterCondition, b: FilterCondition): boolean {
  return a.field === b.field
    && a.comparator === b.comparator
    && (a.headerName ?? '').toLowerCase() === (b.headerName ?? '').toLowerCase();
}

function sameAction(a: FilterAction, b: FilterAction): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'move':
    case 'copy':
      return a.mailboxId && b.mailboxId ? a.mailboxId === b.mailboxId : (a.value ?? '') === (b.value ?? '');
    case 'add_label':
    case 'forward':
    case 'reject':
      return (a.value ?? '') === (b.value ?? '');
    default:
      return true;
  }
}

function sameActions(a: FilterAction[], b: FilterAction[]): boolean {
  if (a.length !== b.length) return false;
  const unmatched = [...b];
  for (const action of a) {
    const index = unmatched.findIndex((other) => sameAction(action, other));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

export type QuickRuleOutcome =
  /** No rule did this yet: `rule` is new, at the top. */
  | { kind: 'created'; rules: FilterRule[]; rule: FilterRule }
  /** `rule` already did this for other values and now covers these too. */
  | { kind: 'merged'; rules: FilterRule[]; rule: FilterRule }
  /** `rule` already covers every value; nothing to write. */
  | { kind: 'covered'; rule: FilterRule };

/**
 * Save a one-click rule without piling up near-duplicates: an enabled
 * Bulwark rule with a single condition of the same kind and the same actions
 * takes the new values into its value list and keeps its name and place. A
 * rule with a period only acts within it, and the new values would too, so
 * it is never the one.
 */
export function applyQuickRule(rules: FilterRule[], candidate: FilterRule): QuickRuleOutcome {
  const condition = candidate.conditions[0];
  const target = candidate.conditions.length === 1
    ? rules.find((r) =>
      isBulwarkRule(r)
      && r.enabled
      && !hasPeriod(r)
      && r.conditions.length === 1
      && sameConditionKind(r.conditions[0], condition)
      && sameActions(r.actions, candidate.actions))
    : undefined;

  if (!target) {
    return { kind: 'created', rules: insertRuleAtTop(rules, candidate), rule: candidate };
  }

  const existing = valueList(target.conditions[0].value);
  const known = new Set(existing.map((v) => v.toLowerCase()));
  const added: string[] = [];
  for (const value of valueList(condition.value)) {
    const key = value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    added.push(value);
  }
  if (added.length === 0) return { kind: 'covered', rule: target };

  const merged: FilterRule = {
    ...target,
    conditions: [{ ...target.conditions[0], value: [...existing, ...added] }],
  };
  return { kind: 'merged', rules: rules.map((r) => (r.id === target.id ? merged : r)), rule: merged };
}
