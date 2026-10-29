import { jmapClient } from './jmap-client';
import {
  createSieveScript,
  getSieveAccountId,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  updateSieveScript,
} from './sieve';
import { parseScript, type ParseResult } from '../lib/sieve/parser';
import { generateScript, VACATION_SCRIPT_NAME } from '../lib/sieve/generator';
import type { FilterRule } from '../lib/sieve/types';
import { servedLoginOf } from '../lib/draft-login';

// One account's filters script, read and written on its own (webmail
// lib/filters/account-filters.ts). A rule made from a message goes through
// here, not through the filter store: the store holds whichever account the
// Filters settings show, and its copy may be stale.

/** The script was edited by hand and the builder cannot read it back. */
export class OpaqueFiltersError extends Error {
  constructor() {
    super('The filters script was edited by hand');
    this.name = 'OpaqueFiltersError';
  }
}

/** Another login took over while the rule was being saved; nothing was written. */
export class FiltersLoginChangedError extends Error {
  constructor() {
    super('The account changed while the rule was being saved');
    this.name = 'FiltersLoginChangedError';
  }
}

/**
 * Read the account's script from the server, let `modify` change its rules,
 * and write the result back as the active script, keeping the vacation
 * include, its forwarding and audience and the external rules. `modify`
 * returns null when there is nothing to write. A hand-edited script is
 * refused: it is never rewritten from a rule. Resolves to whether it wrote.
 *
 * `expectedLogin` is the login the rule was built in (from its message and
 * folders); nothing is written unless the client still serves it.
 */
export async function updateAccountFilters(
  modify: (rules: FilterRule[]) => FilterRule[] | null,
  accountId: string = getSieveAccountId(),
  expectedLogin?: string | null,
): Promise<boolean> {
  // The client serves one login at a time; a switch while the script is read
  // would write these rules into the other login's account.
  const login = servedLoginOf(jmapClient);
  if (expectedLogin !== undefined && login !== expectedLogin) throw new FiltersLoginChangedError();
  const capabilities = getSieveCapabilities(accountId);
  const all = await getSieveScripts(accountId);
  const scripts = all.filter((s) => s.name !== VACATION_SCRIPT_NAME);
  const vacationActive =
    all.some((s) => s.name === VACATION_SCRIPT_NAME && s.isActive) &&
    !!capabilities?.sieveExtensions?.includes('include');
  const script = scripts.find((s) => s.isActive) || scripts[0] || null;
  const parsed: ParseResult = script
    ? parseScript(await getSieveScriptContent(script.blobId, accountId))
    : { rules: [], isOpaque: false, externalRequires: [] };
  if (parsed.isOpaque) throw new OpaqueFiltersError();

  const rules = modify(parsed.rules);
  if (!rules) return false;
  const content = generateScript(rules, parsed.vacation, {
    externalRequires: parsed.externalRequires,
    includeVacation: !!parsed.includeVacation || vacationActive,
    vacationForward: parsed.vacationForward,
    vacationAudience: parsed.vacationAudience,
    extensions: capabilities?.sieveExtensions,
  });
  if (servedLoginOf(jmapClient) !== login) throw new FiltersLoginChangedError();
  if (script) await updateSieveScript(script.id, content, true, accountId);
  else await createSieveScript('filters', content, true, accountId);
  return true;
}
