import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/email', () => ({
  queryEmails: vi.fn(),
  getEmails: vi.fn(),
  archiveEmails: vi.fn(async () => undefined),
}));

import * as emailApi from '../../api/email';
import { StaleLoadError } from '../../api/jmap-client';
import { reorganizeArchive, type ReorganizeArchiveOptions } from '../reorganize-archive';
import type { Email, Mailbox } from '../../api/types';

// R16: the archive reorganisation runs a page loop of query, get and archive.
// During an account switch the folder list can already be another account's,
// whose folders and messages share ids (Stalwart numbers per account). Every
// request goes on the scope taken at the start, and the loop stops cleanly,
// keeping the progress so far.

const api = vi.mocked(emailApi);
const AT = { gen: 5, accountId: 'c' };
const FOLDERS = [{ id: 'arch', name: 'Archive', role: 'archive' }] as Mailbox[];
const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `m${from + i}`);
const rows = (ids: string[]) => ids.map((id) => ({ id, receivedAt: '2026-01-02T00:00:00Z' }) as Email);

function opts(overrides: Partial<ReorganizeArchiveOptions> = {}): ReorganizeArchiveOptions {
  return {
    at: AT,
    archiveMailboxId: 'arch',
    mode: 'year',
    mailboxes: () => FOLDERS,
    refreshMailboxes: vi.fn(async () => undefined),
    stillServed: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getEmails.mockImplementation(async (ids) => rows(ids));
});

describe('reorganizeArchive', () => {
  it('files every page, each request on the scope it started with', async () => {
    api.queryEmails
      .mockResolvedValueOnce({ ids: page(100), total: 130 })
      .mockResolvedValueOnce({ ids: page(30, 100), total: 30 });
    await expect(reorganizeArchive(opts())).resolves.toEqual({ moved: 130, total: 130, stopped: false });
    expect(api.queryEmails).toHaveBeenCalledWith('arch', { position: 0, limit: 100 }, AT);
    for (const call of api.getEmails.mock.calls) expect(call[1]).toBe(AT);
    expect(api.archiveEmails).toHaveBeenCalledTimes(2);
    for (const call of api.archiveEmails.mock.calls) expect(call[4]).toBe(AT);
  });

  it('stops before the next page once the account is no longer served, keeping the progress', async () => {
    let served = true;
    api.queryEmails.mockResolvedValue({ ids: page(100), total: 300 });
    const refreshMailboxes = vi.fn(async () => { served = false; });
    await expect(reorganizeArchive(opts({ stillServed: () => served, refreshMailboxes })))
      .resolves.toEqual({ moved: 100, total: 300, stopped: true });
    expect(api.queryEmails).toHaveBeenCalledTimes(1);
    expect(api.archiveEmails).toHaveBeenCalledTimes(1);
  });

  it('files nothing with a folder list read after the switch', async () => {
    // The switch lands while the page is being read.
    let served = true;
    api.queryEmails.mockResolvedValue({ ids: page(5), total: 5 });
    api.getEmails.mockImplementation(async (ids) => { served = false; return rows(ids); });
    await expect(reorganizeArchive(opts({ stillServed: () => served })))
      .resolves.toEqual({ moved: 0, total: 5, stopped: true });
    expect(api.archiveEmails).not.toHaveBeenCalled();
  });

  it('stops cleanly when a request is refused unsent after a switch', async () => {
    api.queryEmails
      .mockResolvedValueOnce({ ids: page(100), total: 150 })
      .mockRejectedValueOnce(new StaleLoadError());
    await expect(reorganizeArchive(opts())).resolves.toEqual({ moved: 100, total: 150, stopped: true });
  });

  it('starts nothing for an account not served', async () => {
    await expect(reorganizeArchive(opts({ stillServed: () => false })))
      .resolves.toEqual({ moved: 0, total: 0, stopped: true });
    expect(api.queryEmails).not.toHaveBeenCalled();
  });

  it('still reports a real failure', async () => {
    api.queryEmails.mockRejectedValueOnce(new Error('forbidden'));
    await expect(reorganizeArchive(opts())).rejects.toThrow('forbidden');
  });
});
