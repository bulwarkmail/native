import type { FilterRule, SieveCapabilities, SieveScript } from '../sieve/types';
import { parseScript, type ParseResult } from '../sieve/parser';
import { generateScript, VACATION_SCRIPT_NAME } from '../sieve/generator';
import {
  activateSieveScript,
  createSieveScript,
  deactivateSieveScript,
  deleteSieveScript,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  sieveScope,
  updateSieveScript,
} from '../../api/sieve';
import type { AccountRef } from '../../api/op-scope';

/**
 * One account's filters script, read and written against an explicit
 * accountId (ported from the webmail's lib/filters/account-filters.ts).
 *
 * The filter store keeps a single account's rules for the Settings screen. A
 * rule made from a message belongs to that message's account, which can be
 * another login or another Sieve account, so it must never go through the
 * store's state: that would upload one account's rules into another's script.
 * Every api/sieve call here passes `accountId` explicitly.
 */

/** The account's filters as the server has them right now. */
export interface AccountFilters {
  accountId: string;
  /** The script Bulwark writes: the active non-vacation script, else the first one. */
  script: SieveScript | null;
  /** The script's content, byte for byte ('' when there is no script). */
  content: string;
  parsed: ParseResult;
  /** The script that is active now, which may be the vacation script, or none. */
  activeScriptId: string | null;
  includeVacation: boolean;
  capabilities: SieveCapabilities | null;
}

/** The script was edited by hand and the builder cannot read it back. */
export class OpaqueFiltersError extends Error {
  constructor() {
    super('The filters script was edited by hand');
    this.name = 'OpaqueFiltersError';
  }
}

/**
 * The login the write was made for is no longer the one the client serves
 * (the caller's `stillValid` said no). Nothing further is written.
 */
export class SwitchedAwayError extends Error {
  constructor() {
    super('The account changed');
    this.name = 'SwitchedAwayError';
  }
}

/** Throws SwitchedAwayError unless `stillValid` (when given) still holds. Called right before each write. */
function recheck(stillValid: (() => boolean) | undefined): void {
  if (stillValid && !stillValid()) throw new SwitchedAwayError();
}

/** The script changed after the write that is being undone. */
export class FiltersChangedError extends Error {
  constructor() {
    super('The filters script changed since');
    this.name = 'FiltersChangedError';
  }
}

export function supportsInclude(capabilities: SieveCapabilities | null): boolean {
  return capabilities?.sieveExtensions?.includes('include') ?? false;
}

/**
 * `account`: a Sieve account id, or a scope that binds every read to its
 * connection (undefined: the user's own Sieve account on the live one).
 */
export async function readAccountFilters(account: AccountRef): Promise<AccountFilters> {
  const at = sieveScope(account);
  const { accountId } = at;
  const capabilities = getSieveCapabilities(at);
  const allScripts = await getSieveScripts(at);
  // The server-managed 'vacation' script (RFC 9661 §4) can only be changed
  // through VacationResponse/set.
  const scripts = allScripts.filter((s) => s.name !== VACATION_SCRIPT_NAME);
  // Writing activates the filters script, which switches off an active
  // server vacation script. Include it instead so both keep working.
  const vacationActive =
    allScripts.some((s) => s.name === VACATION_SCRIPT_NAME && s.isActive) && supportsInclude(capabilities);
  const script = scripts.find((s) => s.isActive) || scripts[0] || null;
  const activeScriptId = allScripts.find((s) => s.isActive)?.id ?? null;

  if (!script) {
    return {
      accountId,
      script: null,
      content: '',
      parsed: { rules: [], isOpaque: false, externalRequires: [] },
      activeScriptId,
      includeVacation: vacationActive,
      capabilities,
    };
  }

  const content = await getSieveScriptContent(script.blobId, at);
  const parsed = parseScript(content);
  return {
    accountId,
    script,
    content,
    parsed,
    activeScriptId,
    includeVacation: !parsed.isOpaque && (!!parsed.includeVacation || vacationActive),
    capabilities,
  };
}

/** The script for `rules`, keeping the account's vacation, its forwarding and external requires. */
export function renderFiltersScript(
  rules: FilterRule[],
  filters: Pick<AccountFilters, 'parsed' | 'includeVacation' | 'capabilities'>,
): string {
  return generateScript(rules, filters.parsed.vacation, {
    externalRequires: filters.parsed.externalRequires,
    includeVacation: filters.includeVacation,
    vacationForward: filters.parsed.vacationForward,
    vacationAudience: filters.parsed.vacationAudience,
    extensions: filters.capabilities?.sieveExtensions,
  });
}

/** What a write replaced, so it can be put back exactly. */
export interface FiltersChange {
  accountId: string;
  scriptId: string;
  /** The content that was uploaded. */
  written: string;
  rules: FilterRule[];
  previous: {
    /** null when the write created the script. */
    scriptId: string | null;
    content: string;
    activeScriptId: string | null;
  };
}

/**
 * Bring the Settings screen up to date when it shows the account just
 * written. The store is imported lazily because filter-store itself imports
 * this module (supportsInclude, writeFiltersScript).
 */
async function refreshFilterStore(accountId: string): Promise<void> {
  try {
    const { useFilterStore } = await import('../../stores/filter-store');
    if (useFilterStore.getState().selectedAccountId === accountId) {
      await useFilterStore.getState().fetchFilters(accountId);
    }
  } catch {
    // The write already happened; a failed refresh must not report it as failed.
  }
}

/**
 * Upload `content` as the account's filters script and make it the active
 * one: the existing script is updated, or a "filters" script is created.
 * Shared by the Settings save and by rules made from a message. An undefined
 * account is the user's own Sieve account; a scope binds both calls to its
 * connection.
 */
export async function writeFiltersScript(
  account: AccountRef,
  content: string,
  scriptId: string | null,
): Promise<{ scriptId: string }> {
  if (scriptId) {
    await updateSieveScript(scriptId, content, true, account);
    return { scriptId };
  }
  const script = await createSieveScript('filters', content, true, account);
  return { scriptId: script.id };
}

/**
 * Read the account's script from the server, let `modify` change its rules,
 * and write the result back as the active script. The script is read right
 * before the write, so a stale copy (the store's, or one another device has
 * changed since) is never uploaded. `modify` returns null when there is
 * nothing to write. Hand-edited scripts are refused: they are never
 * rewritten from a rule. `stillValid` is checked right before the write;
 * when it says no, nothing is written (SwitchedAwayError). The read and the
 * write run on one connection: the scope given, or the live one now.
 */
export async function updateAccountFilters(
  account: AccountRef,
  modify: (rules: FilterRule[], filters: AccountFilters) => FilterRule[] | null,
  stillValid?: () => boolean,
): Promise<FiltersChange | null> {
  const at = sieveScope(account);
  const { accountId } = at;
  const filters = await readAccountFilters(at);
  if (filters.parsed.isOpaque) throw new OpaqueFiltersError();
  const rules = modify(filters.parsed.rules, filters);
  if (!rules) return null;

  const written = renderFiltersScript(rules, filters);
  recheck(stillValid);
  const { scriptId } = await writeFiltersScript(at, written, filters.script?.id ?? null);
  void refreshFilterStore(accountId);
  return {
    accountId,
    scriptId,
    written,
    rules,
    previous: {
      scriptId: filters.script?.id ?? null,
      content: filters.content,
      activeScriptId: filters.activeScriptId,
    },
  };
}

/**
 * Undo `change`: the script gets its previous bytes back and whichever
 * script was active before is active again; a script the write created is
 * removed. Refused with FiltersChangedError when the script is no longer
 * what the write left (compared byte for byte), so a later edit from here or
 * another device is not thrown away. `stillValid` is checked right before
 * each write; when it says no, nothing more is written (SwitchedAwayError).
 */
export async function restoreAccountFilters(change: FiltersChange, stillValid?: () => boolean): Promise<void> {
  const { accountId, scriptId, previous } = change;
  const scripts = await getSieveScripts(accountId);
  const current = scripts.find((s) => s.id === scriptId);
  if (!current) throw new FiltersChangedError();
  const content = await getSieveScriptContent(current.blobId, accountId);
  if (content !== change.written) throw new FiltersChangedError();

  const restoreActive = async () => {
    if (previous.activeScriptId === scriptId) return;
    recheck(stillValid);
    if (previous.activeScriptId) await activateSieveScript(previous.activeScriptId, accountId);
    else await deactivateSieveScript(accountId);
  };

  if (previous.scriptId) {
    recheck(stillValid);
    await updateSieveScript(scriptId, previous.content, previous.activeScriptId === scriptId, accountId);
    await restoreActive();
  } else {
    // An active script cannot be destroyed (RFC 9661), so switch back first.
    await restoreActive();
    recheck(stillValid);
    await deleteSieveScript(scriptId, accountId);
  }
  void refreshFilterStore(accountId);
}
