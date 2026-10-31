import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleDeepLink, parseDeepLink } from '../linking';

// `/contacts/new` opened the Contacts tab with nothing, and `/contacts/<id>/edit`
// only the contact (file 10 "deep links new/edit", 06 "Contact deep links").
// Webmail lib/deep-links.ts parseContactsPath.

const nav = () => ({ isReady: () => true, navigate: vi.fn() });
const open = async (url: string) => {
  const navigation = nav();
  const link = parseDeepLink(url);
  expect(await handleDeepLink(link!, { navigation: navigation as never, resolveThreadId: async () => null })).toBe(true);
  return navigation.navigate.mock.calls[0];
};

describe('contact deep links', () => {
  it('parses new and edit links, and the older query form', () => {
    expect(parseDeepLink('bulwarkmobile://contacts/new')).toEqual({ kind: 'contact-new' });
    expect(parseDeepLink('https://mail.example.com/contacts/new?addEmail=a%40b.co&name=Ada%20Lovelace'))
      .toEqual({ kind: 'contact-new', email: 'a@b.co', name: 'Ada Lovelace' });
    expect(parseDeepLink('bulwarkmobile://contacts/new?email=a@b.co&addName=Ada'))
      .toEqual({ kind: 'contact-new', email: 'a@b.co', name: 'Ada' });
    expect(parseDeepLink('bulwarkmobile://contacts/C%2F1/edit')).toEqual({ kind: 'contact', contactId: 'C/1', edit: true });
    expect(parseDeepLink('bulwarkmobile://contacts/C1')).toEqual({ kind: 'contact', contactId: 'C1' });
    expect(parseDeepLink('https://mail.example.com/contacts?contactId=C1&view=edit'))
      .toEqual({ kind: 'contact', contactId: 'C1', edit: true });
    expect(parseDeepLink('https://mail.example.com/contacts?addEmail=a@b.co'))
      .toEqual({ kind: 'contact-new', email: 'a@b.co' });
    expect(parseDeepLink('bulwarkmobile://contacts')).toEqual({ kind: 'contacts' });
  });

  it('opens the contact form, filled in or on the card', async () => {
    expect(await open('bulwarkmobile://contacts/new')).toEqual(['ContactForm', {}]);
    expect(await open('bulwarkmobile://contacts/new?addEmail=a@b.co&name=Ada'))
      .toEqual(['ContactForm', { prefill: { email: 'a@b.co', name: 'Ada' } }]);
    expect(await open('bulwarkmobile://contacts/new?name=Ada')).toEqual(['ContactForm', { prefill: { name: 'Ada' } }]);
    expect(await open('bulwarkmobile://contacts/C1/edit')).toEqual(['ContactForm', { contactId: 'C1' }]);
    expect(await open('bulwarkmobile://contacts/C1')).toEqual(['ContactDetail', { contactId: 'C1' }]);
  });

  // No RN renderer in the test env: check the form's wiring instead.
  it('fills the form from a name-only link and waits for the card of an edit link', () => {
    const form = fs.readFileSync(path.resolve(__dirname, '../../screens/ContactFormScreen.tsx'), 'utf8');
    expect(form).toMatch(/if \(prefill\?\.email \|\| prefill\?\.name\) \{/);
    expect(form).toMatch(/if \(isEdit && !existing\) return;/);
    expect(form).toMatch(/if \(filledFromExisting\.current \|\| !existing\) return;/);
    expect(form).toMatch(/const asGroup = asGroupParam \|\| existing\?\.kind === 'group';/);
  });
});
