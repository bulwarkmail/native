import { describe, expect, it, vi, beforeEach } from 'vitest';

// An .eml imported into Drafts came in as read mail, not as a draft the
// composer opens (webmail lib/file-drop/import-keywords.ts, #1535).

const importEmailBlob = vi.hoisted(() => vi.fn(async () => 'new-id'));

vi.mock('../../api/email', () => ({
  importEmailBlob,
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 's' })),
  getSharedMailboxes: vi.fn(async () => []),
  unprefixMailboxId: (id: string) => id,
}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn(async () => ({ blobId: 'blob-1' })) }));
vi.mock('../../lib/eml-import', () => ({
  expandImportableEml: vi.fn(async () => [{ name: 'a.eml', bytes: new Uint8Array([1]) }]),
}));
vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

import { importKeywords, useEmailStore } from '../email-store';

const MAILBOXES = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 },
  { id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 0, unreadEmails: 0 },
];

beforeEach(() => {
  importEmailBlob.mockClear();
  useEmailStore.setState({ mailboxes: MAILBOXES as never, currentMailboxId: 'other' });
});

describe('importing .eml files', () => {
  it('makes a message imported into Drafts an editable draft', async () => {
    await useEmailStore.getState().importEmails([{ uri: 'file:///a.eml', name: 'a.eml', mimeType: 'message/rfc822' }], 'drafts');
    expect(importEmailBlob).toHaveBeenCalledWith('blob-1', 'drafts', { $seen: true, $draft: true }, undefined);
  });

  it('imports into any other folder as read mail', async () => {
    await useEmailStore.getState().importEmails([{ uri: 'file:///a.eml', name: 'a.eml', mimeType: 'message/rfc822' }], 'inbox');
    expect(importEmailBlob).toHaveBeenCalledWith('blob-1', 'inbox', { $seen: true }, undefined);
    expect(importKeywords(undefined)).toEqual({ $seen: true });
  });
});
