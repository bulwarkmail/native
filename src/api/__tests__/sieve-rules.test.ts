import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  isConnected: true,
  username: 'me@example.org',
  serverUrl: 'https://mail.example.org',
}));
vi.mock('../jmap-client', () => ({ jmapClient: client }));

vi.mock('../sieve', () => ({
  createSieveScript: vi.fn(async () => ({ id: 'new', name: 'filters', blobId: 'b', isActive: true })),
  getSieveAccountId: vi.fn(() => 'own'),
  getSieveCapabilities: vi.fn(() => ({
    implementation: 't', maxSizeScript: 1e6, notificationMethods: [], externalLists: [],
    sieveExtensions: ['fileinto', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus', 'mailbox', 'mailboxid'],
  })),
  getSieveScriptContent: vi.fn(),
  getSieveScripts: vi.fn(),
  updateSieveScript: vi.fn(async () => undefined),
}));

import * as sieve from '../sieve';
import { FiltersLoginChangedError, OpaqueFiltersError, updateAccountFilters } from '../sieve-rules';
import { generateScript } from '../../lib/sieve/generator';
import { parseScript } from '../../lib/sieve/parser';
import type { FilterRule } from '../../lib/sieve/types';

const api = vi.mocked(sieve);

const rule = (id: string): FilterRule => ({
  id, name: id, enabled: true, matchType: 'all', stopProcessing: true,
  conditions: [{ field: 'from', comparator: 'address_is', value: `${id}@example.com` }],
  actions: [{ type: 'mark_read' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  client.username = 'me@example.org';
});

describe('updateAccountFilters', () => {
  it('adds the rule to the script the server has and keeps its forwarding and audience', async () => {
    const stored = generateScript([rule('old')], undefined, {
      includeVacation: true,
      vacationForward: { enabled: true, to: 'backup@example.org', keepCopy: true },
      vacationAudience: { only: 'internal', domains: ['example.org'] },
    });
    api.getSieveScripts.mockResolvedValue([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 'v', name: 'vacation', blobId: 'bv', isActive: false },
    ]);
    api.getSieveScriptContent.mockResolvedValue(stored);

    expect(await updateAccountFilters((rules) => [rule('new'), ...rules], 'own')).toBe(true);
    const [id, content, activate, accountId] = api.updateSieveScript.mock.calls[0];
    expect([id, activate, accountId]).toEqual(['s1', true, 'own']);
    const written = parseScript(content as string);
    expect(written.rules.map((r) => r.id)).toEqual(['new', 'old']);
    expect(written.includeVacation).toBe(true);
    expect(written.vacationForward?.to).toBe('backup@example.org');
    expect(written.vacationAudience?.only).toBe('internal');
  });

  it('creates the filters script when there is none', async () => {
    api.getSieveScripts.mockResolvedValue([]);
    await updateAccountFilters(() => [rule('new')], 'own');
    expect(api.createSieveScript).toHaveBeenCalledWith('filters', expect.stringContaining('# Rule: new'), true, 'own');
  });

  it('refuses a hand-edited script', async () => {
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    // Metadata from a version this build does not know reads as opaque.
    api.getSieveScriptContent.mockResolvedValue('/* @metadata:begin\n{"version":3,"rules":[]}\n@metadata:end */\nkeep;\n');
    await expect(updateAccountFilters(() => [rule('new')], 'own')).rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(api.updateSieveScript).not.toHaveBeenCalled();
  });

  it('writes nothing when the rule changes nothing', async () => {
    api.getSieveScripts.mockResolvedValue([]);
    expect(await updateAccountFilters(() => null, 'own')).toBe(false);
    expect(api.createSieveScript).not.toHaveBeenCalled();
  });

  // The client serves one login; ids repeat across servers.
  it('writes nothing once another login took over', async () => {
    api.getSieveScripts.mockImplementation(async () => {
      client.username = 'other@example.net';
      return [];
    });
    await expect(updateAccountFilters(() => [rule('new')], 'own')).rejects.toBeInstanceOf(FiltersLoginChangedError);
    expect(api.createSieveScript).not.toHaveBeenCalled();
  });

  // A rule made from a message and the folders of the login the sheet
  // opened in, saved after a switch.
  it('writes nothing into another login than the one the rule was built in', async () => {
    api.getSieveScripts.mockResolvedValue([]);
    const modify = vi.fn(() => [rule('new')]);
    client.username = 'other@example.net';
    await expect(updateAccountFilters(modify, 'own', 'me@example.org@mail.example.org'))
      .rejects.toBeInstanceOf(FiltersLoginChangedError);
    expect(api.getSieveScripts).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect(api.createSieveScript).not.toHaveBeenCalled();

    client.username = 'me@example.org';
    expect(await updateAccountFilters(modify, 'own', 'me@example.org@mail.example.org')).toBe(true);
    expect(api.createSieveScript).toHaveBeenCalledTimes(1);
  });
});
