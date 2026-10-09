import { describe, it, expect, vi, beforeEach } from 'vitest';

const addTrustedSender = vi.fn((_email: string) => undefined);
const addToTrustedSendersBook = vi.fn(async (_entry: string) => undefined);
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: { getState: () => ({ addTrustedSender }) } }));
vi.mock('../../stores/contacts-store', () => ({ useContactsStore: { getState: () => ({ addToTrustedSendersBook }) } }));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => ({ session: null }) } }));

import { trustRecipients } from '../trust-recipients';

beforeEach(() => {
  addTrustedSender.mockClear();
  addToTrustedSendersBook.mockClear();
});

describe('trustRecipients', () => {
  it('trusts every accepted recipient', () => {
    trustRecipients([{ email: 'ann@ok.example' }, { email: 'bob@ok.example' }], [{ email: 'bob@ok.example' }], { syncToBook: true });
    expect(addTrustedSender.mock.calls.map((c) => c[0])).toEqual(['ann@ok.example']);
    expect(addToTrustedSendersBook).toHaveBeenCalledWith('ann@ok.example');
  });

  it('skips an excluded address, however it is cased or spaced', () => {
    trustRecipients(
      [{ name: 'CEO', email: ' CEO@Bank.example' }, { email: 'ann@ok.example' }],
      undefined,
      { syncToBook: true, exclude: ['ceo@bank.example'] },
    );
    expect(addTrustedSender.mock.calls.map((c) => c[0])).toEqual(['ann@ok.example']);
    expect(addToTrustedSendersBook.mock.calls.map((c) => c[0])).toEqual(['ann@ok.example']);
  });
});
