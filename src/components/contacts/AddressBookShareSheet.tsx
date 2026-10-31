import React from 'react';
import type { AddressBook, AddressBookRights } from '../../api/types';
import { useLocaleStore } from '../../stores/locale-store';
import { ShareCollectionSheet, type SharePreset } from '../sharing/ShareCollectionSheet';

// The webmail's address book presets (lib/jmap/share-rights ADDRESS_BOOK_PRESETS):
// no free/busy, which only calendars have.
export const ADDRESS_BOOK_PRESETS = {
  read: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
  readWrite: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  manager: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
} satisfies Record<string, AddressBookRights>;

interface AddressBookShareSheetProps {
  /** Null hides the sheet. */
  book: AddressBook | null;
  onShare: (bookId: string, principalId: string, rights: AddressBookRights | null) => Promise<void>;
  onClose: () => void;
}

// JMAP sharing for an own address book (webmail ShareCollectionDialog, kind
// "addressBook"): pick a principal, choose a role.
export function AddressBookShareSheet({ book, onShare, onClose }: AddressBookShareSheetProps) {
  const t = useLocaleStore((s) => s.t);
  const presets = React.useMemo<SharePreset<AddressBookRights>[]>(() => [
    { key: 'read', label: t('sharing.preset.read', 'Read only'), rights: ADDRESS_BOOK_PRESETS.read },
    { key: 'readWrite', label: t('sharing.preset.readWrite', 'Read & write'), rights: ADDRESS_BOOK_PRESETS.readWrite },
    { key: 'manager', label: t('sharing.preset.manager', 'Manager'), rights: ADDRESS_BOOK_PRESETS.manager },
  ], [t]);
  return (
    <ShareCollectionSheet
      collection={book}
      presets={presets}
      addRights={ADDRESS_BOOK_PRESETS.read}
      onShare={onShare}
      onClose={onClose}
    />
  );
}
