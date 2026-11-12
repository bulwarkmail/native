import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRelatedContact } from '../contact-related';
import type { ContactCard } from '../../api/types';

// #1578: a related contact showed as its uid.
const card = (id: string, uid: string, accountId?: string): ContactCard =>
  ({ id, uid, addressBookIds: {}, name: { full: id }, ...(accountId ? { accountId } : {}) }) as ContactCard;

describe('related contacts', () => {
  const me = card('me', 'urn:uuid:aaa');
  const anna = card('anna', 'urn:uuid:5F0B-1111');
  const annaShared = card('acc:anna', 'urn:uuid:5f0b-1111', 'acc');

  it('finds the card a relatedTo key names, with or without urn:uuid and in any case', () => {
    expect(findRelatedContact('urn:uuid:5f0b-1111', me, [me, anna, annaShared])?.id).toBe('anna');
    expect(findRelatedContact('5F0B-1111', me, [me, anna])?.id).toBe('anna');
  });

  it('prefers the card in the same account, and takes the only one elsewhere', () => {
    expect(findRelatedContact('5f0b-1111', { id: 'x', accountId: 'acc' }, [anna, annaShared])?.id).toBe('acc:anna');
    expect(findRelatedContact('5f0b-1111', me, [annaShared])?.id).toBe('acc:anna');
  });

  it('finds nothing for a name or a URL an import kept there, nor the card itself', () => {
    expect(findRelatedContact('Grandma', me, [me, anna])).toBeUndefined();
    expect(findRelatedContact('urn:uuid:aaa', me, [me])).toBeUndefined();
  });

  // No render setup in the repo: the contact screen is checked for showing
  // the related card's name through the helper.
  it('is what the contact screen shows and opens', () => {
    const src = readFileSync(join(__dirname, '../../screens/ContactDetailScreen.tsx'), 'utf-8');
    expect(src).toMatch(/const related = findRelatedContact\(uri, contact, allContacts\);/);
    expect(src).toMatch(/navigation\.push\('ContactDetail', \{ contactId: related\.id \}\)/);
  });
});
