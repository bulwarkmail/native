import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/sieve', () => ({
  createSieveScript: vi.fn(),
  getSieveAccountId: vi.fn(() => 'own'),
  getSieveCapabilities: vi.fn(() => null),
  getSieveScriptContent: vi.fn(),
  getSieveScripts: vi.fn(),
  isSieveSupported: vi.fn(() => true),
  updateSieveScript: vi.fn(),
  validateSieveScript: vi.fn(async () => ({ isValid: true })),
}));

import fs from 'node:fs';
import path from 'node:path';
import * as sieve from '../../api/sieve';
import { generateScript } from '../sieve/generator';
import type { FilterRule } from '../sieve/types';
import { useFilterStore } from '../../stores/filter-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import { useToastStore } from '../../stores/toast-store';
import {
  deleteFilterRuleWithUndo, deleteKeywordWithUndo, removeTrustedSenderWithUndo, UNDO_TOAST_DURATION,
} from '../settings-undo';

// Deleting a filter rule, a tag or a trusted sender in Settings goes at once
// with an Undo in the toast instead of a confirm (webmail R3).

const api = vi.mocked(sieve);
const t = (key: string, fallback?: string) => `${key}|${fallback ?? ''}`;
const toasts = () => useToastStore.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

function rule(id: string, name: string): FilterRule {
  return {
    id, name, enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.com` }],
    actions: [{ type: 'move', value: 'Archive' }],
    stopProcessing: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSieveAccountId.mockReturnValue('own');
  api.isSieveSupported.mockReturnValue(true);
  api.getSieveCapabilities.mockReturnValue(null);
  useFilterStore.getState().clearState();
  useToastStore.getState().clearToasts();
});

describe('deleteFilterRuleWithUndo', () => {
  async function load() {
    api.getSieveScripts.mockResolvedValue([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]);
    api.getSieveScriptContent.mockResolvedValue(generateScript([rule('a', 'A'), rule('b', 'B')]));
    await useFilterStore.getState().selectAccount(null);
  }

  it('deletes and saves without asking, and the toast Undo saves the rule back', async () => {
    await load();
    api.updateSieveScript.mockResolvedValue(undefined);

    await deleteFilterRuleWithUndo('a', t);
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['b']);
    expect(api.updateSieveScript).toHaveBeenCalledTimes(1);
    expect(lastToast()).toMatchObject({ type: 'success', title: 'notifications.filters_deleted|Filter rule deleted' });
    expect(lastToast().action?.label).toBe('notifications.rule_undo|Undo');

    lastToast().action!.onPress();
    await vi.waitFor(() => expect(api.updateSieveScript).toHaveBeenCalledTimes(2));
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('says the save failed and keeps the rule when the server refuses', async () => {
    await load();
    api.updateSieveScript.mockRejectedValueOnce(new Error('down'));

    await deleteFilterRuleWithUndo('a', t);
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['a', 'b']);
    expect(toasts()).toHaveLength(1);
    expect(lastToast()).toMatchObject({ type: 'error', title: 'notifications.filters_save_failed|Failed to save filters' });
  });

  it('says the save failed when the Undo cannot be saved', async () => {
    await load();
    api.updateSieveScript.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));
    await deleteFilterRuleWithUndo('a', t);
    lastToast().action!.onPress();
    await vi.waitFor(() => expect(lastToast().type).toBe('error'));
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['b']);
  });
});

describe('deleteKeywordWithUndo', () => {
  beforeEach(() => {
    useKeywordsStore.setState({
      keywords: [
        { id: 'red', label: 'Red', color: 'red' },
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'home', label: 'Home', color: 'green' },
      ],
    } as never);
  });

  it('deletes the tag at once and Undo puts it back where it was', () => {
    deleteKeywordWithUndo('work', t);
    expect(useKeywordsStore.getState().keywords.map((k) => k.id)).toEqual(['red', 'home']);
    expect(lastToast()).toMatchObject({ type: 'success', title: 'settings.keywords.deleted|Tag deleted' });

    lastToast().action!.onPress();
    expect(useKeywordsStore.getState().keywords.map((k) => k.id)).toEqual(['red', 'work', 'home']);
    // A second tap does not add it twice.
    lastToast().action!.onPress();
    expect(useKeywordsStore.getState().keywords.map((k) => k.id)).toEqual(['red', 'work', 'home']);
  });
});

describe('removeTrustedSenderWithUndo', () => {
  function stores() {
    return {
      removeLocal: vi.fn(),
      addLocal: vi.fn(),
      removeFromBook: vi.fn(async () => undefined),
      addToBook: vi.fn(async () => undefined),
    };
  }

  it('removes the sender from the list and the book, and Undo adds it back to both', async () => {
    const s = stores();
    await removeTrustedSenderWithUndo({ email: 'ann@example.com', local: true, synced: true }, s, t);
    expect(s.removeFromBook).toHaveBeenCalledWith('ann@example.com');
    expect(s.removeLocal).toHaveBeenCalledWith('ann@example.com');
    expect(lastToast()).toMatchObject({
      type: 'success',
      title: 'settings.email_behavior.trusted_senders.removed|Removed from trusted senders',
      message: 'ann@example.com',
      duration: UNDO_TOAST_DURATION,
    });

    lastToast().action!.onPress();
    expect(s.addLocal).toHaveBeenCalledWith('ann@example.com');
    expect(s.addToBook).toHaveBeenCalledWith('ann@example.com');
  });

  it('only touches the places the sender was in', async () => {
    const s = stores();
    await removeTrustedSenderWithUndo({ email: 'bo@example.com', local: true, synced: false }, s, t);
    lastToast().action!.onPress();
    expect(s.removeFromBook).not.toHaveBeenCalled();
    expect(s.addToBook).not.toHaveBeenCalled();
    expect(s.addLocal).toHaveBeenCalledWith('bo@example.com');
  });

  it('changes nothing and says so when the address book cannot be written', async () => {
    const s = stores();
    s.removeFromBook.mockRejectedValueOnce(new Error('down'));
    await removeTrustedSenderWithUndo({ email: 'ann@example.com', local: true, synced: true }, s, t);
    expect(s.removeLocal).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(lastToast()).toMatchObject({ type: 'error', title: "settings.email_behavior.trusted_senders.remove_error|Couldn't remove the sender" });
  });
});

// No React Native renderer in the test env: the panes are checked for the
// wiring.
describe('settings panes', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../components/settings', file), 'utf8');

  it('filters: deletes with Undo and warns about the forward limit (#1155, #1208)', () => {
    const src = read('FilterSettings.tsx');
    expect(src).toMatch(/void deleteFilterRuleWithUndo\(rule\.id, t\)/);
    expect(src).not.toMatch(/settings\.filters\.delete_confirm/);
    expect(src).toMatch(/rulesForwardLimit\(rules, vacationForward, sieveCapabilities\?\.maxNumberRedirects\)/);
    expect(src).toMatch(/forwardLimit\.ignored && \(\s*<Text[^>]*>\s*\{t\('settings\.filters\.forward_unavailable'/);
    expect(src).toMatch(/forwardLimit\.tooMany && \(\s*<Text[^>]*>\s*\{t\('settings\.filters\.forward_limit'/);
  });

  it('tags: deletes with Undo', () => {
    const src = read('KeywordSettings.tsx');
    expect(src).toMatch(/deleteKeywordWithUndo\(id, t\)/);
    expect(src).not.toMatch(/delete_confirm_title/);
  });

  it('trusted senders: removes with Undo, shown above the list modal', () => {
    const src = read('ContentSendersSettings.tsx');
    expect(src).toMatch(/await removeTrustedSenderWithUndo\(row, \{/);
    expect(src).not.toMatch(/sync_remove_failed/);
    expect(src).toMatch(/<ToastHost \/>\s*<\/Modal>/);
  });
});
