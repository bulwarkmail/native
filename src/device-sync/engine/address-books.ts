/**
 * One Android account per synced address book (#155; docs/device-sync.md,
 * "Account type and accounts"): contacts apps build their source list from
 * accounts, so only a book with an account of its own can be shown or hidden
 * there.
 *
 * The app account's own Android account then holds no contacts. Its contacts
 * sync keeps the books' accounts in step with the selection and asks for
 * their syncs; each book's account is synced by an ordinary run restricted
 * to that book (`RunEnv.collection`).
 */
import { CONTACTS_AUTHORITY, type AndroidAccount, type RequestSyncOptions } from '../types';
import type { CapabilityAccount } from '../jmap/session';
import type { ContactsSync } from './contacts-sync';
import type { RunEnv } from './context';
import type { EngineDeps } from './deps';
import { accountOfRef } from './kinds';
import { teardownAuthority } from './teardown';

/** The longest a book's waiting changes may take to upload before its account goes. */
const BOOK_TEARDOWN_MS = 30_000;

/** The Android accounts of the app account's address books. */
function bookAccounts(all: readonly AndroidAccount[], registryId: string): Array<AndroidAccount & { collection: string }> {
  return all.filter((a): a is AndroidAccount & { collection: string } => a.registryId === registryId && !!a.collection);
}

/** Whether the app account's own Android account, which the accounts of its address books follow, syncs contacts. */
export async function ownerAccountSyncs(deps: EngineDeps, registryId: string): Promise<boolean> {
  const owner = (await deps.accounts.list()).find((a) => a.registryId === registryId && !a.collection);
  return !!owner && (await deps.isSyncEnabled(owner.name, CONTACTS_AUTHORITY));
}

/**
 * "<login> – <book>", with the owner's name for a shared account's book,
 * and a number when the name is taken.
 */
export function addressBookAccountName(
  ownerName: string,
  book: { name: string; account: Pick<CapabilityAccount, 'name' | 'primary'> },
  taken: ReadonlySet<string>,
): string {
  const base = book.account.primary ? `${ownerName} – ${book.name}` : `${ownerName} – ${book.name} (${book.account.name})`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
  return name;
}

/**
 * Uploads what the account's rows still hold for the server, then removes
 * its rows; false when changes are left, and the rows with them.
 */
async function empty(env: RunEnv, accountName: string): Promise<boolean> {
  await env.checkpoints.check('address-books');
  const timeoutMs = Math.min(BOOK_TEARDOWN_MS, env.checkpoints.budgetMs() - env.tuning.deadlineMarginMs);
  const { pending } = await teardownAuthority(env.deps, env.registryId, accountName, CONTACTS_AUTHORITY, {
    lockHeld: true,
    uploadFirst: timeoutMs > 0,
    timeoutMs,
  });
  if (pending > 0) {
    env.report.itemError({
      ref: accountName,
      side: 'upload',
      type: 'pendingChanges',
      description: `${pending} changes made on this device have not reached the server yet`,
    });
  }
  return pending === 0;
}

/**
 * The sync of the app account's own account while every address book has an
 * account of its own: contacts it still holds (synced before the books got
 * accounts, or created in it by a contacts app) go up and leave, books that
 * sync get an account, accounts of books that no longer sync are emptied and
 * removed, and every book's account is asked to sync.
 */
export async function syncAddressBookAccounts(env: RunEnv, contacts: ContactsSync): Promise<void> {
  const { deps, registryId } = env;
  // Its SyncState goes with its rows: a later sync of its own must not continue from a state whose rows are gone.
  const used =
    (await env.reader.rows('raw_contacts', ['_id'])).length > 0 ||
    (await env.reader.rows('groups', ['_id'])).length > 0 ||
    !!(await env.reader.readSyncState());
  const { manual, expedited, overrideTooManyDeletions, discardLocalDeletions } = env.extras;
  const options: RequestSyncOptions = { manual, expedited, overrideTooManyDeletions, discardLocalDeletions };
  if (used && !(await empty(env, env.accountName))) {
    // No book gets an account until these are gone (both would show the same contacts); those that have one sync on.
    for (const account of bookAccounts(await deps.accounts.list(), registryId)) {
      await deps.accounts.requestSync(account.name, CONTACTS_AUTHORITY, options);
    }
    return;
  }

  const { books, unreadable } = await contacts.addressBooks();
  const synced = new Map(books.filter((b) => b.selected).map((b) => [b.key, b]));
  const all = await deps.accounts.list();
  const existing = bookAccounts(all, registryId);
  const known = env.prefs.addressBookAccounts ?? {};
  const live: string[] = [];

  for (const account of existing) {
    const key = account.collection;
    // An account that refuses to list its books may list them again: its books' accounts stay.
    if (synced.has(key) || unreadable.has(accountOfRef(key) ?? '')) {
      if (known[key] !== account.name) await deps.recordAddressBookAccount(registryId, key, account.name);
      live.push(account.name);
    } else if (await empty(env, account.name)) {
      // Forgotten first: the app must not take the removal for one made in Android Settings.
      await deps.recordAddressBookAccount(registryId, key, null);
      await deps.accounts.remove(account.name);
    } else {
      // Its own sync tries the upload again.
      live.push(account.name);
    }
  }

  const taken = new Set(all.map((a) => a.name));
  for (const [key, book] of synced) {
    if (existing.some((a) => a.collection === key)) continue;
    if (known[key]) {
      // Removed in Android Settings: the book stops syncing instead of coming back.
      await deps.deselectAddressBook(registryId, key);
      await deps.recordAddressBookAccount(registryId, key, null);
      continue;
    }
    await env.checkpoints.check('address-books');
    const name = addressBookAccountName(env.accountName, book, taken);
    await deps.accounts.addAddressBook(name, registryId, key);
    await deps.recordAddressBookAccount(registryId, key, name);
    taken.add(name);
    live.push(name);
  }
  for (const key of Object.keys(known)) {
    if (synced.has(key) || existing.some((a) => a.collection === key) || unreadable.has(accountOfRef(key) ?? '')) continue;
    await deps.recordAddressBookAccount(registryId, key, null);
  }

  for (const name of live) await deps.accounts.requestSync(name, CONTACTS_AUTHORITY, options);
}

/**
 * Before the app account's own account syncs contacts itself: accounts its
 * address books had are emptied and removed. False while one still holds
 * changes the server has not got: the own account would show the same
 * contacts a second time.
 */
export async function foldAddressBookAccounts(env: RunEnv): Promise<boolean> {
  let folded = true;
  for (const account of bookAccounts(await env.deps.accounts.list(), env.registryId)) {
    if (await empty(env, account.name)) {
      await env.deps.recordAddressBookAccount(env.registryId, account.collection, null);
      await env.deps.accounts.remove(account.name);
    } else {
      folded = false;
    }
  }
  return folded;
}
