import type { RuleSender, RulesMenuAvailability } from './quick-rules';

/**
 * What the Rules sheet lists for one message or a selection (ported from the
 * webmail's rules-menu.tsx). Pure: the sheet turns these into rows, labelling
 * them with the sender, domain and list.
 */

export type RulesSheetItemId =
  | 'move_sender'
  | 'move_domain'
  | 'move_list'
  | 'mark_read'
  | 'tag'
  | 'block'
  | 'create'
  | 'manage';

export interface RulesSheetModel {
  availability: RulesMenuAvailability;
  /** The senders of the messages, the user's own addresses already left out. */
  senders: RuleSender[];
  /** The one domain every sender shares. */
  domain: string | null;
  /** The one List-Id every message carries. */
  listId: string | null;
  hasJunk: boolean;
  hasTags: boolean;
  /** The account's script was edited by hand, so rules cannot be added. */
  opaque: boolean;
}

export interface RulesSheetItem {
  id: RulesSheetItemId;
  disabled: boolean;
  /** An i18n key (`context_menu.rules.*`) saying why the item is disabled. */
  hint?: string;
}

export const OPAQUE_HINT_KEY = 'context_menu.rules.opaque_hint';
export const CROSS_ACCOUNT_HINT_KEY = 'context_menu.rules.cross_account';
export const NO_JUNK_HINT_KEY = 'context_menu.rules.no_junk';

export function rulesSheetItems(model: RulesSheetModel): RulesSheetItem[] {
  if (model.availability === 'hidden') return [];
  const hasSenders = model.senders.length > 0;
  const ids: RulesSheetItemId[] = [];
  if (hasSenders) ids.push('move_sender');
  if (hasSenders && model.domain) ids.push('move_domain');
  if (model.listId) ids.push('move_list');
  if (hasSenders) ids.push('mark_read');
  if (hasSenders && model.hasTags) ids.push('tag');
  if (hasSenders) ids.push('block');
  ids.push('create', 'manage');

  return ids.map((id): RulesSheetItem => {
    if (model.availability === 'cross_account') {
      return { id, disabled: true, hint: CROSS_ACCOUNT_HINT_KEY };
    }
    if (model.opaque && id !== 'manage') {
      return { id, disabled: true, hint: OPAQUE_HINT_KEY };
    }
    if (id === 'block' && !model.hasJunk) {
      return { id, disabled: true, hint: NO_JUNK_HINT_KEY };
    }
    return { id, disabled: false };
  });
}

/** What the Rules sheet reads of a target's filters script, kept with the target it was read for. */
export interface TargetFilters {
  /** The target's `key`: the app account and the JMAP account, since ids repeat across logins. */
  targetKey: string;
  /** The script was edited by hand. */
  opaque: boolean;
  /** The forwards around a new rule, for the server's redirect limit; null when unknown. */
  forwards: {
    maxRedirects: number | null;
    periodsSupported: boolean;
    before: number;
    after: number;
  } | null;
}

/** `read` while `targetKey` is still the target it was read for, else null. */
export function targetFiltersFor<T extends { targetKey: string }>(read: T | null, targetKey: string | undefined): T | null {
  return read && targetKey !== undefined && read.targetKey === targetKey ? read : null;
}
