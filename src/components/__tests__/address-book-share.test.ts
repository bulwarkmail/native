import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Address books could not be shared on the phone (file 10 "address book
// sharing", 06 "Address book share / visibility management"). Webmail
// ShareCollectionDialog with kind "addressBook", offered for own books the
// user may share. No RN renderer in the test env: this checks the wiring.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('address book sharing', () => {
  it('offers the webmail presets, without free/busy', () => {
    const sheet = read('components/contacts/AddressBookShareSheet.tsx');
    expect(sheet).toMatch(/read: \{ mayRead: true, mayWrite: false, mayShare: false, mayDelete: false \}/);
    expect(sheet).toMatch(/readWrite: \{ mayRead: true, mayWrite: true, mayShare: false, mayDelete: false \}/);
    expect(sheet).toMatch(/manager: \{ mayRead: true, mayWrite: true, mayShare: true, mayDelete: true \}/);
    expect(sheet).not.toMatch(/freeBusy/);
    expect(sheet).toMatch(/addRights=\{ADDRESS_BOOK_PRESETS\.read\}/);
  });

  it('is opened from the address book settings for own books the user may share', () => {
    const settings = read('components/settings/ContactsSettings.tsx');
    expect(settings).toMatch(/\{!book\.isShared && book\.myRights\?\.mayShare \? \(\s*<Pressable\s*onPress=\{\(\) => setShareTarget\(book\)\}/);
    expect(settings).toMatch(/<AddressBookShareSheet\s*book=\{shareTarget\}\s*onShare=\{shareAddressBook\}/);
  });

  it('shares one sheet with the calendars', () => {
    expect(read('components/calendar/CalendarShareSheet.tsx')).toMatch(/<ShareCollectionSheet/);
    expect(read('components/contacts/AddressBookShareSheet.tsx')).toMatch(/<ShareCollectionSheet/);
  });
});
