import { describe, it, expect, vi, beforeEach } from 'vitest';

// The templates of a login kept in its Inbox metadata (Stalwart 1.0.0),
// against an in-memory account; 0.16 keeps them on the device.

const { client, server } = vi.hoisted(() => ({
  client: {
    accountId: 'm',
    isConnected: true,
    username: 'me@example.com' as string | null,
    serverUrl: 'https://mail.example.com' as string | null,
  },
  server: {
    /** Metadata entries per account, by key (without the org.bulwarkmail. prefix). */
    entries: {} as Record<string, Record<string, unknown>>,
    supports: new Set<string>(),
    groups: [] as Array<{ id: string; name: string }>,
    writes: [] as Array<[string, string, unknown]>,
    /** Runs before each write; throwing fails it. */
    beforeWrite: null as null | ((key: string) => void),
  },
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/bulwark-metadata', () => {
  class MetadataTooLargeError extends Error {}
  return {
    MetadataTooLargeError,
    supportsBulwarkMetadata: (accountId: string) => server.supports.has(accountId),
    getBulwarkMetadata: async (accountId: string) =>
      (server.supports.has(accountId) ? structuredClone(server.entries[accountId] ?? {}) : null),
    setBulwarkMetadata: async (accountId: string, key: string, value: unknown) => {
      server.beforeWrite?.(key);
      server.writes.push([accountId, key, value]);
      const entries = (server.entries[accountId] ??= {});
      if (value === null) delete entries[key];
      else entries[key] = structuredClone(value);
    },
    groupAccounts: async () => server.groups,
    isValidMetadataKey: (key: string) => /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/.test(key),
    MAX_METADATA_ENTRY_BYTES: 8192,
    metadataValueBytes: (value: unknown) => JSON.stringify(value).length,
  };
});

import { useAccountStore } from '../account-store';
import { useTemplatesStore, type EmailTemplate } from '../templates-store';

const LOGIN = 'me@example.com@mail.example.com';
const OTHER = 'me@example.com@other.example.org';

const template = (id: string, name: string, updatedAt = '2026-10-01T10:00:00.000Z'): EmailTemplate => ({
  id, name, subject: '', body: `${name} body`, category: '', isFavorite: false, createdAt: updatedAt, updatedAt,
});

beforeEach(() => {
  server.entries = {};
  server.supports = new Set();
  server.groups = [];
  server.writes = [];
  server.beforeWrite = null;
  client.serverUrl = 'https://mail.example.com';
  useAccountStore.setState({ activeAccountId: LOGIN });
  useTemplatesStore.setState({
    templates: [], storedInAccount: false, teams: [], hydrated: true, device: [], accounts: {}, deviceListOwner: null,
  });
});

const refresh = () => useTemplatesStore.getState().refresh({ force: true });

describe('templates on a server without Metadata (Stalwart 0.16)', () => {
  it('keeps them on the device and asks the server nothing', async () => {
    useTemplatesStore.getState().addTemplate({ name: 'Thanks', subject: '', body: 'Thanks!' });
    await refresh();
    const state = useTemplatesStore.getState();
    expect(state.storedInAccount).toBe(false);
    expect(state.templates.map((t) => t.name)).toEqual(['Thanks']);
    expect(state.device.map((t) => t.name)).toEqual(['Thanks']);
    expect(server.writes).toEqual([]);
  });
});

describe('templates kept in the account (Stalwart 1.0)', () => {
  beforeEach(() => server.supports.add('m'));

  it('moves the device list into the first login that keeps templates, with a marker', async () => {
    useTemplatesStore.setState({ device: [template('tpl-a', 'Thanks')], templates: [template('tpl-a', 'Thanks')] });

    await refresh();

    expect(server.entries.m['template.tpl-a']).toMatchObject({ id: 'tpl-a', name: 'Thanks' });
    expect(server.entries.m.templates).toEqual({ version: 1, deleted: {} });
    const state = useTemplatesStore.getState();
    expect(state.storedInAccount).toBe(true);
    expect(state.deviceListOwner).toBe(LOGIN);
    expect(state.templates.map((t) => t.id)).toEqual(['tpl-a']);
  });

  it("brings in the account's templates from the webmail", async () => {
    server.entries.m = { 'template.web-1': template('web-1', 'From the web'), templates: { version: 1, deleted: {} } };

    await refresh();

    expect(useTemplatesStore.getState().templates.map((t) => t.name)).toEqual(['From the web']);
    expect(server.writes).toEqual([]);
  });

  it('deletes everywhere through a tombstone, written before the entry goes', async () => {
    server.entries.m = { 'template.web-1': template('web-1', 'Old'), templates: { version: 1, deleted: {} } };
    await refresh();

    useTemplatesStore.getState().deleteTemplate('web-1');
    await refresh();

    expect(server.entries.m['template.web-1']).toBeUndefined();
    expect(Object.keys((server.entries.m.templates as { deleted: object }).deleted)).toEqual(['web-1']);
    expect(server.writes.map(([, key, value]) => [key, value === null])).toEqual([
      ['templates', false],
      ['template.web-1', true],
    ]);
    expect(useTemplatesStore.getState().templates).toEqual([]);
  });

  it('uploads a template missing from the server again instead of taking it for deleted', async () => {
    server.entries.m = { 'template.web-1': template('web-1', 'Kept'), templates: { version: 1, deleted: {} } };
    await refresh();
    // Another client lost the entry without a tombstone.
    delete server.entries.m['template.web-1'];

    await refresh();

    expect(server.entries.m['template.web-1']).toMatchObject({ name: 'Kept' });
    expect(useTemplatesStore.getState().templates.map((t) => t.name)).toEqual(['Kept']);
  });

  it('takes the newer version of a template edited on both sides', async () => {
    server.entries.m = { 'template.web-1': template('web-1', 'First'), templates: { version: 1, deleted: {} } };
    await refresh();
    server.entries.m['template.web-1'] = template('web-1', 'Edited in the webmail', '2026-10-20T10:00:00.000Z');

    await refresh();

    expect(useTemplatesStore.getState().templates.map((t) => t.name)).toEqual(['Edited in the webmail']);
  });

  it('gives the device list to one login only', async () => {
    useTemplatesStore.setState({ device: [template('tpl-a', 'Mine')] });
    await refresh();

    useAccountStore.setState({ activeAccountId: OTHER });
    client.serverUrl = 'https://other.example.org';
    server.entries.m = {};
    await refresh();

    expect(useTemplatesStore.getState().templates).toEqual([]);
    expect(server.entries.m['template.tpl-a']).toBeUndefined();
  });

  it('writes nothing more once another login is active', async () => {
    useTemplatesStore.setState({ device: [template('tpl-a', 'A'), template('tpl-b', 'B')] });
    server.beforeWrite = () => {
      // The first write lands, then a notification tap switches logins.
      server.beforeWrite = null;
      useAccountStore.setState({ activeAccountId: OTHER });
      client.serverUrl = 'https://other.example.org';
    };

    await refresh();

    expect(server.writes).toHaveLength(1);
  });

  it('reads the team templates of group accounts for the picker', async () => {
    server.supports.add('team');
    server.groups = [{ id: 'team', name: 'team@example.com' }];
    server.entries.team = { 'template.t1': template('t1', 'Team reply') };

    await refresh();

    expect(useTemplatesStore.getState().teams).toEqual([
      { accountId: 'team', name: 'team@example.com', templates: [expect.objectContaining({ name: 'Team reply' })] },
    ]);
  });
});
