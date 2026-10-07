import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockSieveAccount, sieveRouter } from './sieve-mock';

const router = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof sieveRouter> }));
const session = vi.hoisted(() => ({
  value: {
    capabilities: { 'urn:ietf:params:jmap:sieve': {} },
    accounts: {
      own: { isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:sieve': {} } },
      team: { isPersonal: false },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:sieve': 'own' },
  } as Record<string, unknown> | null,
}));

vi.mock('../../../api/sieve', async () => {
  const actual = await vi.importActual<typeof import('../../../api/sieve')>('../../../api/sieve');
  const route = (name: string) => (...args: unknown[]) =>
    (router.current.module as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  return {
    ...actual,
    getSieveAccountId: () => 'own',
    isSieveSupported: () => true,
    getSieveCapabilities: route('getSieveCapabilities'),
    getSieveScripts: route('getSieveScripts'),
    getSieveScriptContent: route('getSieveScriptContent'),
    updateSieveScript: route('updateSieveScript'),
    createSieveScript: route('createSieveScript'),
    deleteSieveScript: route('deleteSieveScript'),
    activateSieveScript: route('activateSieveScript'),
    deactivateSieveScript: route('deactivateSieveScript'),
    validateSieveScript: async () => ({ isValid: true }),
  };
});

vi.mock('../../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'own',
    username: 'u@example.com',
    serverUrl: 'https://mail.example.com',
    get currentSession() { return session.value; },
    getMaxObjectsInGet: () => 500,
    getMaxObjectsInSet: () => limits.set,
    getMaxCallsInRequest: () => 16,
    request: vi.fn(),
  },
}));
const limits = vi.hoisted(() => ({ set: 500 }));

vi.mock('../../../api/email', async () => {
  const actual = await vi.importActual<typeof import('../../../api/email')>('../../../api/email');
  return {
    ...actual,
    queryEmailFields: vi.fn(async () => []),
    moveEmails: vi.fn(async () => {}),
    patchKeywordsForEmails: vi.fn(async () => {}),
    copyEmailsWithinAccount: vi.fn(async () => {}),
  };
});

vi.mock('../../active-client-account', () => ({ clientServesActiveAccount: vi.fn(() => true) }));

import * as emailApi from '../../../api/email';
import type { Email, Mailbox } from '../../../api/types';
import { generateScript } from '../../sieve/generator';
import { parseScript } from '../../sieve/parser';
import type { FilterRule } from '../../sieve/types';
import { useAccountStore } from '../../../stores/account-store';
import { useEmailStore } from '../../../stores/email-store';
import { useToastStore } from '../../../stores/toast-store';
import { clientServesActiveAccount } from '../../active-client-account';
import { RetroactiveTooComplexError } from '../retroactive';
import { applyToExisting, runPresetRule, saveEditorRule, SwitchedAwayError } from '../quick-rule-flow';
import { resolveQuickRuleTarget, type QuickRuleTarget } from '../quick-rule-target';
import { collectSenders, sharedDomain, type QuickRuleSubject } from '../quick-rules';

const api = vi.mocked(emailApi);

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}) =>
  ({ id, name, role, parentId: null, myRights: { mayAddItems: true }, ...extra }) as unknown as Mailbox;
// Stalwart numbers each account's folders from 'a': the team Inbox has the
// same bare id as the user's own, and the store namespaces it as 'team:a'.
const mailboxes = [
  box('a', 'Inbox', 'inbox'),
  box('news', 'News', null),
  box('junk', 'Junk', 'junk'),
  box('team:a', 'Inbox', 'inbox', { originalId: 'a', isShared: true, accountId: 'team' }),
  box('team:n', 'Team News', null, { originalId: 'n', isShared: true, accountId: 'team' }),
];

function targetFor(id: string, overrides: Partial<QuickRuleTarget> = {}): QuickRuleTarget {
  return {
    appAccountId: 'app-1',
    jmapAccountId: id,
    sieveAccountId: id,
    key: `app-1|${id}`,
    shared: false,
    supportsSieve: true,
    mailboxes: mailboxes.filter((m) => !m.isShared),
    sourceMailboxId: 'a',
    ...overrides,
  };
}

function subject(...addresses: string[]): QuickRuleSubject {
  const senders = collectSenders(addresses.map((email) => ({ from: [{ email, name: '' }] })), new Set());
  return { senders, domain: sharedDomain(senders), listId: null };
}

function rule(id: string, overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
    actions: [{ type: 'move', value: 'News', mailboxId: 'news' }],
    stopProcessing: true,
    ...overrides,
  };
}

const news = { id: 'news', path: 'News', name: 'News' };
const lastToast = () => useToastStore.getState().toasts.at(-1)!;
const sieveOf = (...args: Parameters<typeof mockSieveAccount>) => router.current.register(mockSieveAccount(...args));
const moveRule = rule('first', { name: 'Newsletters' });

beforeEach(() => {
  router.current = sieveRouter();
  useToastStore.getState().clearToasts();
  vi.clearAllMocks();
  api.queryEmailFields.mockReset().mockResolvedValue([]);
  vi.mocked(clientServesActiveAccount).mockReturnValue(true);
  limits.set = 500;
  useAccountStore.setState({ activeAccountId: 'app-1' } as never);
  useEmailStore.setState({ mailboxes, currentMailboxId: 'a', emails: [] } as never);
});

describe('runPresetRule', () => {
  it("writes the rule into the target account's script, and only there", async () => {
    const own = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    const other = sieveOf('other', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    await runPresetRule({ target: targetFor('other'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com') });

    expect(own.writes()).toBe(0);
    const written = parseScript(other.content('filters'));
    expect(written.rules[0]).toMatchObject({
      conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
      actions: [{ type: 'move', mailboxId: 'news' }],
    });
    expect(lastToast().title).toBe('Rule created');
    expect(lastToast().message).toBe(written.rules[0].name);
  });

  it('adds a second sender to the same rule, and Undo restores the script exactly', async () => {
    const before = generateScript([moveRule]);
    const account = sieveOf('own', [{ name: 'filters', content: before, isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('bob@acme.com') });

    const merged = parseScript(account.content('filters')).rules;
    expect(merged).toHaveLength(1);
    expect(merged[0].conditions[0].value).toEqual(['anna@acme.com', 'bob@acme.com']);
    expect(lastToast().title).toBe('Added to rule “Newsletters”');
    expect(lastToast().action?.label).toBe('Undo');
    expect(lastToast().duration).toBe(12_000);

    lastToast().action!.onPress();
    await vi.waitFor(() => expect(lastToast().title).toBe('Rule change undone'));
    expect(account.content('filters')).toBe(before);
  });

  it('says so when Undo meets a script that changed since', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'mark_read' }, subject: subject('bob@acme.com') });
    const undo = lastToast().action!;
    await router.current.module.updateSieveScript(account.scripts[0].id, generateScript([rule('later')]), true, 'own');
    undo.onPress();
    await vi.waitFor(() => expect(lastToast().type).toBe('error'));
    expect(lastToast().title).toBe('Your filters have changed since. Undo the change in Filters settings.');
  });

  it('writes nothing when the sender is already covered', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([moveRule]), isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('Anna@acme.com') });
    expect(account.writes()).toBe(0);
    expect(lastToast()).toMatchObject({ type: 'info', title: 'Already covered by rule “Newsletters”' });
  });

  it('refuses a hand-edited script and says why', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: 'require "fileinto";', isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'mark_read' }, subject: subject('anna@acme.com') });
    expect(account.writes()).toBe(0);
    expect(lastToast()).toMatchObject({ type: 'error', title: 'Your filters were edited by hand. Open Filters settings' });
  });

  it('refuses a move while the server\'s capabilities are unknown and says why', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    account.api.getSieveCapabilities.mockReturnValue(null as never);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com') });
    expect(account.writes()).toBe(0);
    expect(lastToast()).toMatchObject({
      type: 'error',
      title: 'Failed to save filters',
      message: 'The server has not said yet what your filters can do. Try again in a moment.',
    });
  });

  it('writes nothing for a shared account or one without Sieve', async () => {
    const account = sieveOf('team', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    await runPresetRule({ target: targetFor('team', { shared: true }), preset: { kind: 'mark_read' }, subject: subject('a@acme.com') });
    await runPresetRule({ target: targetFor('team', { supportsSieve: false }), preset: { kind: 'mark_read' }, subject: subject('a@acme.com') });
    expect(account.writes()).toBe(0);
    expect(lastToast().type).toBe('error');
  });

  it('blocks into Junk with the spam guard off', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'block', junk: { id: 'junk', path: 'Junk', name: 'Junk' } }, subject: subject('spam@acme.com') });
    expect(parseScript(account.content('filters')).rules[0].includeSpam).toBe(true);
  });

  it('offers "Apply to N existing" only when matching mail is found, and runs it in the message account', async () => {
    sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    api.queryEmailFields.mockResolvedValue([
      { id: 'e1', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'joanna@acme.com' }] },
      { id: 'e3', mailboxIds: { a: true }, keywords: { $seen: true }, from: [{ email: 'ANNA@acme.com' }] },
    ]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com') });

    expect(api.queryEmailFields).toHaveBeenCalledWith(
      { operator: 'AND', conditions: [{ inMailbox: 'a' }, { from: 'anna@acme.com' }] },
      ['mailboxIds', 'keywords', 'from'],
      { accountId: 'own' },
    );
    const { secondaryAction } = lastToast();
    expect(secondaryAction?.label).toBe('Apply to 2 existing messages');

    secondaryAction!.onPress();
    await vi.waitFor(() => expect(lastToast().title).toBe('Rule applied to 2 messages'));
    expect(api.moveEmails).toHaveBeenCalledWith(['e1', 'e3'], 'a', 'news', 'own');
  });

  it('offers no apply action when nothing matches or there is no source folder', async () => {
    sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com') });
    expect(lastToast().secondaryAction).toBeUndefined();
    expect(api.queryEmailFields).toHaveBeenCalledTimes(1);

    await runPresetRule({ target: targetFor('own', { sourceMailboxId: null }), preset: { kind: 'move_sender', mailbox: { id: 'junk', path: 'Junk', name: 'Junk' } }, subject: subject('anna@acme.com') });
    expect(lastToast().secondaryAction).toBeUndefined();
    expect(api.queryEmailFields).toHaveBeenCalledTimes(1);
  });
});

describe('saveEditorRule', () => {
  it('saves "Create rule…" as built, at the top, without merging', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([rule('first')]), isActive: true }]);
    await saveEditorRule(rule('built'), { target: targetFor('own') });
    expect(parseScript(account.content('filters')).rules.map((r) => r.id)).toEqual(['built', 'first']);
    expect(lastToast().title).toBe('Rule created');
    expect(lastToast().action?.label).toBe('Undo');
    expect(api.moveEmails).not.toHaveBeenCalled();
  });

  it('saves an edit in place and applies nothing', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([rule('x'), rule('first')]), isActive: true }]);
    await saveEditorRule(rule('first', { name: 'Renamed' }), { target: targetFor('own'), mode: 'edit', applyToExisting: true });
    expect(parseScript(account.content('filters')).rules.map((r) => [r.id, r.name])).toEqual([['x', 'Rule x'], ['first', 'Renamed']]);
    expect(api.queryEmailFields).not.toHaveBeenCalled();
  });

  it('applies the new rule at once when asked, and reports the count', async () => {
    sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    api.queryEmailFields.mockResolvedValue([{ id: 'e1', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] }]);
    await saveEditorRule(rule('built'), { target: targetFor('own'), applyToExisting: true });
    expect(api.moveEmails).toHaveBeenCalledWith(['e1'], 'a', 'news', 'own');
    expect(lastToast()).toMatchObject({ title: 'Rule created', message: 'Rule applied to 1 message' });
  });

  it('still saves the rule when applying it fails, and says so', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    api.queryEmailFields.mockRejectedValue(new Error('boom'));
    await saveEditorRule(rule('built'), { target: targetFor('own'), applyToExisting: true });
    expect(parseScript(account.content('filters')).rules).toHaveLength(1);
    const titles = useToastStore.getState().toasts.map((t) => t.title);
    expect(titles).toContain('Could not apply the rule to existing messages');
    expect(lastToast().title).toBe('Rule created');
  });
});

describe('applyToExisting', () => {
  const rows = (n: number, from = 'anna@acme.com') =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}`, mailboxIds: { a: true }, keywords: {}, from: [{ email: from }] }));

  it("uses the message's account and source folder, not the user's folder with the same bare id", async () => {
    // A team message in the team Inbox, whose bare id 'a' is also the user's own Inbox.
    api.queryEmailFields.mockResolvedValue(rows(1));
    const target = targetFor('team', {
      shared: true,
      sourceMailboxId: 'a',
      mailboxes: mailboxes.filter((m) => m.accountId === 'team'),
    });
    const count = await applyToExisting(target, rule('r', { actions: [{ type: 'move', value: 'Team News', mailboxId: 'n' }] }));

    expect(count).toBe(1);
    expect(api.queryEmailFields).toHaveBeenCalledWith(expect.anything(), expect.anything(), { accountId: 'team' });
    expect(api.moveEmails).toHaveBeenCalledWith(['e0'], 'a', 'n', 'team');
    for (const call of [...api.moveEmails.mock.calls, ...api.queryEmailFields.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('"own"');
    }
  });

  it('works through the plan in batches of maxObjectsInSet', async () => {
    limits.set = 2;
    api.queryEmailFields.mockResolvedValue(rows(5));
    await applyToExisting(targetFor('own'), rule('r', { actions: [{ type: 'mark_read' }] }));
    expect(api.patchKeywordsForEmails.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [['e0', 'e1'], 'own'], [['e2', 'e3'], 'own'], [['e4'], 'own'],
    ]);
  });

  it('copies, tags and moves with the explicit account', async () => {
    api.queryEmailFields.mockResolvedValue(rows(1));
    await applyToExisting(targetFor('own'), rule('r', {
      actions: [{ type: 'add_label', value: 'work' }, { type: 'copy', value: 'News', mailboxId: 'news' }],
    }));
    expect(api.patchKeywordsForEmails).toHaveBeenCalledWith(['e0'], { '$label:work': true }, 'own');
    expect(api.copyEmailsWithinAccount).toHaveBeenCalledWith(['e0'], 'news', 'own');
  });

  it('refreshes the list when it holds rows of that account, and not otherwise', async () => {
    const refreshEmails = vi.fn(async () => {});
    const fetchMailboxes = vi.fn(async () => {});
    useEmailStore.setState({ refreshEmails, fetchMailboxes, emails: [{ id: 'e0', mailboxIds: { a: true } }] } as never);
    api.queryEmailFields.mockResolvedValue(rows(1));
    await applyToExisting(targetFor('own'), rule('r'));
    expect(refreshEmails).toHaveBeenCalledTimes(1);

    refreshEmails.mockClear();
    await applyToExisting(targetFor('team', { shared: true }), rule('r'));
    expect(refreshEmails).not.toHaveBeenCalled();
  });

  it('reports a rule too expensive to run as rule_apply_failed, changing nothing', async () => {
    sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    api.queryEmailFields.mockResolvedValue(rows(1));
    // Same failure the planner raises for a rule it cannot afford.
    const spy = vi.spyOn(await import('../retroactive'), 'planRetroactive').mockImplementation(() => { throw new RetroactiveTooComplexError(); });
    await saveEditorRule(rule('r'), { target: targetFor('own'), applyToExisting: true });
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Could not apply the rule to existing messages');
    expect(api.moveEmails).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('after an account switch', () => {
  const matching = [{ id: 'e1', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] }];
  const noServerCalls = () => {
    expect(api.moveEmails).not.toHaveBeenCalled();
    expect(api.patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(api.copyEmailsWithinAccount).not.toHaveBeenCalled();
  };

  async function savedWithApplyOffer() {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    api.queryEmailFields.mockResolvedValue(matching);
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com') });
    api.queryEmailFields.mockClear();
    return account;
  }

  it('Apply sends nothing when another login is active, and says to switch back', async () => {
    await savedWithApplyOffer();
    const apply = lastToast().secondaryAction!;
    useAccountStore.setState({ activeAccountId: 'app-2', accounts: [{ id: 'app-1', email: 'a@x.org', username: 'a' }] } as never);
    apply.onPress();
    await vi.waitFor(() => expect(lastToast().title).toBe('Switch back to a@x.org to finish this'));
    expect(api.queryEmailFields).not.toHaveBeenCalled();
    noServerCalls();
  });

  it('Apply sends nothing while the client lags the active account', async () => {
    await savedWithApplyOffer();
    const apply = lastToast().secondaryAction!;
    vi.mocked(clientServesActiveAccount).mockReturnValue(false);
    apply.onPress();
    await vi.waitFor(() => expect(lastToast().type).toBe('error'));
    expect(api.queryEmailFields).not.toHaveBeenCalled();
    noServerCalls();
  });

  it('Undo is refused, with no Sieve call, and works again after switching back', async () => {
    const account = await savedWithApplyOffer();
    const undo = lastToast().action!;
    const calls = () => account.api.getSieveScripts.mock.calls.length;
    const before = calls();
    const writes = account.writes();
    useAccountStore.setState({ activeAccountId: 'app-2' } as never);
    undo.onPress();
    expect(lastToast().title).toContain('Switch back to');
    expect(calls()).toBe(before);
    expect(account.writes()).toBe(writes);

    useAccountStore.setState({ activeAccountId: 'app-1' } as never);
    undo.onPress();
    undo.onPress();
    await vi.waitFor(() => expect(lastToast().title).toBe('Rule change undone'));
    expect(account.api.getSieveScripts.mock.calls.length - before).toBe(1);
  });

  it('stops between two batches when the account changes, and reports a partial apply', async () => {
    limits.set = 1;
    api.queryEmailFields.mockResolvedValue([
      { id: 'e1', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
    ]);
    api.moveEmails.mockImplementationOnce(async () => {
      useAccountStore.setState({ activeAccountId: 'app-2' } as never);
    });
    await expect(applyToExisting(targetFor('own'), rule('r'))).rejects.toMatchObject({ name: 'PartialApplyError' });
    expect(api.moveEmails).toHaveBeenCalledTimes(1);
  });

  it('says some messages may already have changed when a later batch fails', async () => {
    sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    limits.set = 1;
    api.queryEmailFields.mockResolvedValue([
      { id: 'e1', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { a: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
    ]);
    api.moveEmails.mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));
    await saveEditorRule(rule('r'), { target: targetFor('own'), applyToExisting: true });
    const errors = useToastStore.getState().toasts.filter((t) => t.type === 'error');
    expect(errors[0].title).toContain('Some messages may already have been changed');
  });

  it('a one-click rule writes nothing when the account switches while the script is read', async () => {
    useAccountStore.setState({ activeAccountId: 'app-1', accounts: [{ id: 'app-1', email: 'a@x.org', username: 'a' }] } as never);
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    account.api.getSieveScripts.mockImplementationOnce(async () => {
      useAccountStore.setState({ activeAccountId: 'app-2' } as never);
      return account.scripts.map((x) => ({ ...x }));
    });
    await runPresetRule({ target: targetFor('own'), preset: { kind: 'mark_read' }, subject: subject('anna@acme.com') });
    expect(account.writes()).toBe(0);
    expect(lastToast()).toMatchObject({ type: 'error', title: 'Switch back to a@x.org to finish this' });
  });

  it('the rule editor writes nothing when the account switches while the script is read', async () => {
    const account = sieveOf('own', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    account.api.getSieveScripts.mockImplementationOnce(async () => {
      vi.mocked(clientServesActiveAccount).mockReturnValue(false);
      return account.scripts.map((x) => ({ ...x }));
    });
    await saveEditorRule(rule('r'), { target: targetFor('own') });
    expect(account.writes()).toBe(0);
    expect(lastToast().title).toContain('Switch back to');
  });

  it('Undo writes nothing when the account switches during its read, and can be used again', async () => {
    const account = await savedWithApplyOffer();
    const undo = lastToast().action!;
    const writes = account.writes();
    account.api.getSieveScripts.mockImplementationOnce(async () => {
      useAccountStore.setState({ activeAccountId: 'app-2' } as never);
      return account.scripts.map((x) => ({ ...x }));
    });
    undo.onPress();
    await vi.waitFor(() => expect(lastToast().title).toContain('Switch back to'));
    expect(account.writes()).toBe(writes);

    useAccountStore.setState({ activeAccountId: 'app-1' } as never);
    undo.onPress();
    await vi.waitFor(() => expect(lastToast().title).toBe('Rule change undone'));
  });

  it('applyToExisting itself refuses, so the immediate apply of the editor is covered too', async () => {
    useAccountStore.setState({ activeAccountId: 'app-2' } as never);
    await expect(applyToExisting(targetFor('own'), rule('r'))).rejects.toBeInstanceOf(SwitchedAwayError);
    expect(api.queryEmailFields).not.toHaveBeenCalled();
  });
});

describe('resolveQuickRuleTarget', () => {
  const email = (mailboxIds: Record<string, boolean>, extra: Partial<Email> = {}) =>
    ({ id: 'e1', mailboxIds, from: [{ email: 'b@example.org' }], keywords: {}, ...extra }) as unknown as Email;
  afterEach(() => { session.value = { ...(session.value as object) }; });

  it('treats a message in the own Inbox as own, although a team Inbox has the same bare id', () => {
    const target = resolveQuickRuleTarget(email({ a: true }));
    expect(target).toMatchObject({
      appAccountId: 'app-1', jmapAccountId: 'own', sieveAccountId: 'own', shared: false, supportsSieve: true, sourceMailboxId: 'a',
    });
    expect(target!.mailboxes.map((m) => m.id)).toEqual(['a', 'news', 'junk']);
  });

  it("takes the viewer's account for a team message, and calls it shared", () => {
    const target = resolveQuickRuleTarget(email({ a: true }), { viewedAccountId: 'team' })!;
    expect(target).toMatchObject({ jmapAccountId: 'team', shared: true, sieveAccountId: 'team', sourceMailboxId: 'a' });
    expect(target.mailboxes.map((m) => m.id)).toEqual(['team:a', 'team:n']);
  });

  it("an explicit viewer account of undefined means the user's own, over a list stamp", () => {
    const stamped = email({ a: true }, { jmapAccountId: 'team' } as Partial<Email>);
    expect(resolveQuickRuleTarget(stamped)?.shared).toBe(true);
    expect(resolveQuickRuleTarget(stamped, { viewedAccountId: undefined })?.shared).toBe(false);
  });

  it('honours an explicit source folder, and is null while the client lags the active account', () => {
    expect(resolveQuickRuleTarget(email({ a: true }), { sourceMailboxId: 'news' })?.sourceMailboxId).toBe('news');
    expect(resolveQuickRuleTarget(email({ a: true }), { sourceMailboxId: null })?.sourceMailboxId).toBeNull();
    vi.mocked(clientServesActiveAccount).mockReturnValue(false);
    expect(resolveQuickRuleTarget(email({ a: true }))).toBeNull();
  });

  it('reports no Sieve support when the session does not advertise it', () => {
    session.value = { capabilities: {}, accounts: {}, primaryAccounts: {} };
    expect(resolveQuickRuleTarget(email({ a: true }))?.supportsSieve).toBe(false);
  });
});
