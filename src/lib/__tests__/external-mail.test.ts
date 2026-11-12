import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mail from and to outside the organisation (webmail lib/external-mail.ts,
// lib/outgoing/external-recipients.ts): the "External" sender chip and the
// confirm before sending outside it.

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { serverUrl: null, username: null, usesBearerAuth: false, currentSession: null, onAuthFailure: vi.fn() },
}));
vi.mock('../client-cert', () => ({ fetchWithoutForeignRedirect: vi.fn(), secureFetch: vi.fn() }));
vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import { usePolicyStore } from '../../stores/policy-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useContactsStore } from '../../stores/contacts-store';
import { sanitizePolicy } from '../org-policy';
import {
  externalMailPolicyOf,
  externalRecipients,
  externalSenders,
  internalDomains,
  isExternalAddress,
  senderIsInternal,
} from '../external-mail';
import { recipientsToConfirm } from '../outgoing/external-recipients';
import { collectSendWarnings, sendWarningsContent } from '../compose-send-warnings';
import type { ContactCard, Identity } from '../../api/types';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

describe('who is outside', () => {
  const internal = internalDomains(['me@example.com'], ['partner.org', 'BÜCHER.de']);

  it('counts the identities\' and the admin\'s domains, subdomains included, IDNs in ASCII', () => {
    expect(internal).toEqual(['example.com', 'partner.org', 'xn--bcher-kva.de']);
    expect(isExternalAddress('a@eu.example.com', internal)).toBe(false);
    expect(isExternalAddress('Ann <a@partner.org>', internal)).toBe(false);
    expect(isExternalAddress('a@bücher.de', internal)).toBe(false);
    expect(isExternalAddress('a@notexample.com', internal)).toBe(true);
    // Nobody can be told apart without a known domain.
    expect(isExternalAddress('a@other.org', [])).toBe(false);
  });

  it('lists each external recipient once, in the first field', () => {
    expect(externalRecipients({ to: ['x@other.org', 'me2@example.com'], cc: ['X@other.org'], bcc: ['y@third.org'] }, internal))
      .toEqual([
        { address: 'x@other.org', domain: 'other.org', field: 'to' },
        { address: 'y@third.org', domain: 'third.org', field: 'bcc' },
      ]);
    expect(externalRecipients({ to: ['x@other.org'], cc: [], bcc: [] }, internal, (key) => key === 'x@other.org')).toEqual([]);
  });

  it('flags a sender outside, and one without a domain', () => {
    expect(externalSenders([{ email: 'a@other.org' }], internal)).toEqual([{ address: 'a@other.org', domain: 'other.org' }]);
    expect(externalSenders([{ email: 'ceo' }], internal)).toEqual([{ address: 'ceo', domain: '' }]);
    expect(externalSenders([{ email: 'a@example.com' }], internal)).toEqual([]);
    expect(senderIsInternal([{ email: 'a@partner.org' }], internal)).toBe(true);
    expect(senderIsInternal([{ email: 'a@other.org' }], internal)).toBe(false);
  });

  it('reads the policy section with its defaults', () => {
    expect(externalMailPolicyOf(undefined)).toEqual({ senderLabel: false, recipientWarning: false, domains: [], trustContacts: true });
    expect(externalMailPolicyOf({ externalMail: { senderLabel: true, recipientWarning: 'yes', domains: ['a.org', 3], trustContacts: false } }))
      .toEqual({ senderLabel: true, recipientWarning: false, domains: ['a.org'], trustContacts: false });
  });
});

describe('the confirm before sending outside', () => {
  const contact = (address: string, books: string[]): ContactCard => ({
    id: address, addressBookIds: Object.fromEntries(books.map((b) => [b, true])), emails: { e: { address } },
  } as unknown as ContactCard);

  function withPolicy(externalMail: Record<string, unknown>) {
    usePolicyStore.setState({
      accountId: null, byAccount: {}, configPending: false, links: {},
      effective: sanitizePolicy({ organisation: { externalMail } }),
    });
  }

  beforeEach(() => {
    useSettingsStore.setState({ identities: [{ id: 'i1', name: 'Me', email: 'me@example.com' } as Identity] });
    useContactsStore.setState({
      contacts: [contact('known@other.org', ['ab1']), contact('trusted@other.org', ['tsb'])],
      addressBooks: [{ id: 'ab1', name: 'Personal' }, { id: 'tsb', name: 'Trusted Senders' }],
      trustedSendersBookId: 'tsb',
      contactsFetchedAt: 1,
    } as never);
  });

  it('asks about recipients outside when the organisation turns it on', async () => {
    withPolicy({ recipientWarning: true, domains: ['partner.org'] });
    const out = await recipientsToConfirm({
      to: ['a@example.com', 'b@partner.org', 'c@other.org'], cc: ['known@other.org'], bcc: ['trusted@other.org'],
      identityEmail: 'me@example.com',
    });
    // A contact doesn't count; a card only in "Trusted Senders" does.
    expect(out.map((r) => r.address)).toEqual(['c@other.org', 'trusted@other.org']);
  });

  it('asks about contacts too without "trust contacts", and nothing with the warning off', async () => {
    withPolicy({ recipientWarning: true, trustContacts: false });
    expect((await recipientsToConfirm({ to: ['known@other.org'], cc: [], bcc: [], identityEmail: 'me@example.com' })).length).toBe(1);
    withPolicy({ recipientWarning: false });
    expect(await recipientsToConfirm({ to: ['c@other.org'], cc: [], bcc: [], identityEmail: 'me@example.com' })).toEqual([]);
  });

  it('counts a group identity\'s own domain as internal', async () => {
    withPolicy({ recipientWarning: true });
    expect(await recipientsToConfirm({ to: ['x@group.example'], cc: [], bcc: [], identityEmail: 'team@group.example' })).toEqual([]);
  });

  it('joins the composer\'s one send-check sheet, alone or with the others', () => {
    const recipients = [{ address: 'c@other.org', domain: 'other.org', field: 'to' as const }];
    const alone = collectSendWarnings({
      subject: 'Hi', askSubject: false, placeholders: null, confirmedPlaceholders: new Set(), externalRecipients: recipients,
    });
    expect(alone).toEqual([{ kind: 'external', recipients }]);
    expect(sendWarningsContent(alone, t)).toMatchObject({
      title: 'Send outside your organisation?',
      recipients,
      backLabel: 'Back',
      sendLabel: 'Send anyway',
    });
    const both = collectSendWarnings({
      subject: '', askSubject: true, placeholders: null, confirmedPlaceholders: new Set(), externalRecipients: recipients,
    });
    expect(both.map((w) => w.kind)).toEqual(['subject', 'external']);
    expect(sendWarningsContent(both, t).items[1]).toMatchObject({ kind: 'external', recipients });
  });
});
