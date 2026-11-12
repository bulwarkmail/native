// The composer's recipient picker (webmail components/contacts/
// directory-picker-dialog.tsx): the user's own contacts, and the server's
// directory on a tab of its own; tick people and add them to To, Cc or Bcc.

import type { ContactCard } from '../api/types';
import type { DirectoryEntry } from './contact-directory';
import { getContactDisplayName, isGroup } from './contact-utils';

/** The key one address is ticked under, on either tab. */
export function pickerKey(entry: Pick<DirectoryEntry, 'email'>): string {
  return entry.email.trim().toLowerCase();
}

/** Every address of the user's own contacts, one row each; groups are left out. */
export function contactEntries(contacts: ContactCard[]): DirectoryEntry[] {
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  for (const contact of contacts) {
    if (isGroup(contact)) continue;
    const name = getContactDisplayName(contact);
    for (const email of Object.values(contact.emails ?? {})) {
      const address = email?.address?.trim();
      if (!address) continue;
      const entry = { id: `${contact.id}:${address}`, name: name || address, email: address };
      if (seen.has(pickerKey(entry))) continue;
      seen.add(pickerKey(entry));
      entries.push(entry);
    }
  }
  return entries;
}

/** The ticked entries of both tabs, in list order, each address once. */
export function pickedEntries(selected: ReadonlySet<string>, pools: DirectoryEntry[][]): DirectoryEntry[] {
  const seen = new Set<string>();
  return pools.flat().filter((e) => {
    const key = pickerKey(e);
    if (!selected.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The entries as chips after the ones a field has, without an address twice. */
export function addPickedRecipients<R extends { name: string; email: string; group?: unknown }>(
  prev: R[],
  entries: DirectoryEntry[],
  make: (entry: { name: string; email: string }) => R,
): R[] {
  const seen = new Set(prev.filter((r) => !r.group).map((r) => r.email.toLowerCase()));
  const next = [...prev];
  for (const e of entries) {
    const key = e.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(make({ name: e.name !== e.email ? e.name : '', email: e.email }));
  }
  return next;
}
