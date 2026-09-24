# Contacts & address books

## Summary
RN covers the visible surface reasonably well (list with alphabetical index, detail screen with every RFC 9553 field block, a full edit form, groups with member management, address-book CRUD, vCard import/export, trusted-senders book, contact activity). The gaps are mostly below the UI: the RN JMAP layer (`src/api/contacts.ts`) ignores `notCreated/notUpdated/notDestroyed`, never assigns a UID (#644), does not re-fetch the created card (so a freshly saved contact shows as a blank row), does not paginate `ContactCard/query`, and has no first-touch gate (#907). The RN vCard parser is a stale fork of the web one: it predates #224 (dates are imported as raw strings, which Stalwart drops), lacks every X- vendor extension, Apple grouped labels, and org-only cards (#701). Composer autocomplete is contacts-only (no groups, no recent recipients, no directory), there is no "add sender to contacts" entry point from the viewer, no way to create a group, no shared/group-account address books, and the trusted-senders settings screen cannot show or remove entries that live in the synced book.

## Findings

### JMAP / store layer

- [x] **Newly created contact appears as a blank row until refresh** — `P2` — `bug` — fixed in 580e010
  - What WEB does: `client.createContact` reads the server-assigned id from `created` and then re-fetches the full card with `ContactCard/get` before returning it (`lib/jmap/client.ts:5128-5133`), so the store appends a complete card.
  - What RN does: `createContact` returns `res.methodResponses[0][1].created['new-contact']` verbatim (`src/api/contacts.ts:73`) which per JMAP only carries server-set properties (id, created, updated…); the store appends that stub (`src/stores/contacts-store.ts:170-174`). `ContactFormScreen.handleSave` just `goBack()`s (`src/screens/ContactFormScreen.tsx:631-633`) so the list shows an "Unnamed" row with no email until a push/pull refresh; `doDuplicate` even navigates to that stub (`src/screens/ContactDetailScreen.tsx:231-232`).
  - Fix hint: in `api/contacts.ts` merge `{ ...contact, addressBookIds, ...created }` or issue a follow-up `ContactCard/get` for the created id (mirror WEB) before returning.

- [x] **`ContactCard/set` errors are swallowed or crash with a TypeError** — `P2` — `bug` — fixed in 580e010
  - What WEB does: every set call checks `notCreated` / `notUpdated` / `notDestroyed` and throws the server `description` (`lib/jmap/client.ts:5122-5126, 5155-5160, 5180-5184`); the method-level `error` response is also handled.
  - What RN does: `createContact` indexes `.created['new-contact']` without checking `created`/`notCreated` (`src/api/contacts.ts:73`) so a rejected card surfaces as "Cannot read property 'new-contact' of undefined"; `updateContact` (`:76-85`) and `deleteContacts` (`:87-93`) never look at `notUpdated`/`notDestroyed`, so the store applies the optimistic change (`src/stores/contacts-store.ts:176-195`) although the server refused it (e.g. read-only shared book, invalid PartialDate).
  - Fix hint: route all three through `methodResult()` (already defined at `src/api/contacts.ts:7-15`) and throw on `notCreated/notUpdated/notDestroyed[id].description`; `bulkDelete` should only drop the ids that were actually destroyed.

- [x] **No UID assigned on contact creation (#644)** — `P2` — `bugfix-parity` — fixed in 580e010
  - What WEB does: sends `uid: contactData.uid || 'urn:uuid:<uuid>'` on every create because Stalwart stores the card without one otherwise (`lib/jmap/client.ts:5113-5116`, changelog 1.6.x "Assign a UID to contact cards on creation").
  - What RN does: `createContact` forwards the card as-is (`src/api/contacts.ts:65-70`); form, import, duplicate and trusted-sender creation all go through it. Group membership then falls back to the raw id (`src/screens/GroupDetailScreen.tsx:90`), and exported vCards/CardDAV clients get UID-less cards.
  - Fix hint: add `uid: contact.uid || \`urn:uuid:${generateUUID()}\`` in `api/contacts.ts createContact` (RN already has `src/lib/uuid.ts`).

- [x] **Contact list silently truncated at the query limit (no pagination)** — `P2` — `bug` — fixed in 580e010
  - What WEB does: `fetchPaginatedContacts` walks `ContactCard/query` with `position`/`limit = maxObjectsInGet` until `total` is reached, then batches `ContactCard/get` (`lib/jmap/client.ts:~4985-5022`).
  - What RN does: a single `ContactCard/query` with `limit: 1000` (`src/api/contacts.ts:26-40`); the server may clamp the limit lower and anything beyond is never fetched. `getContacts` batches the get correctly (`:42-57`).
  - Fix hint: loop on `position` until `ids.length < limit || total reached` in `queryContacts`, mirroring WEB.

- [x] **No first-touch gate: concurrent AddressBook/get + ContactCard/query on cold start (#907)** — `P2` — `bugfix-parity` — fixed in 26a34d5
  - Store-side: `fetchAddressBooks`/`fetchContacts` are single-flight and contacts wait for an in-flight AddressBook/get; the request-level `FirstTouchGate` in `src/api/jmap-client.ts` was added by the client agent.
  - What WEB does: `FirstTouchGate` serialises the first request per `(collection, account)` so Stalwart's lazy default-collection creation cannot race across cluster nodes (`lib/jmap/first-touch-gate.ts:1-101`, wired at `lib/jmap/client.ts:678,1129`; changelog 1.9.x "Gate first-touch calendar and contacts requests to stop duplicate default calendars (#907)").
  - What RN does: `ContactsScreen` fires `fetchAddressBooks()` and `fetchContacts()` in the same effect (`src/screens/ContactsScreen.tsx:120-123`) and `restoreSession` fans out `fetchContacts` + `fetchCalendars` (`src/stores/auth-store.ts:91-93`) with no gate in `src/api/jmap-client.ts` (grep for gate/firstTouch: none). Against a multi-node Stalwart this can mint a duplicate default address book / calendar.
  - Fix hint: port `first-touch-gate.ts` into `src/api/` and wrap `jmapClient.request` (key on `AddressBook/`, `ContactCard/`, `Calendar/`, `CalendarEvent/` + accountId); reset it on logout/account switch.

- [x] **Contacts account id: RN uses the mail primary account, not `primaryAccounts[contacts]`** — `P3` — `partial` — fixed in 580e010
  - What WEB does: `getContactsAccountId()` prefers `primaryAccounts["urn:ietf:params:jmap:contacts"]` (`lib/jmap/client.ts:4677-4680`).
  - What RN does: every call uses `jmapClient.accountId`, resolved from the mail/core primary (`src/api/contacts.ts:18,32,44,63`; `src/api/jmap-client.ts:388-399`).
  - Fix hint: add `getContactsAccountId()` to the RN client and use it in `api/contacts.ts`.

- [x] **Shared / group-account address books not listed or writable** — `P2` — `missing` — fixed in 26a34d5
  - Drawer "Shared from X" sections in 358bdb9; writes are routed to the owning account via `originalId`/`accountId`.
  - What WEB does: `getAllAddressBooks`/`getAllContacts` iterate every contacts-capable or non-personal account, namespace ids as `accountId:bookId`, tag `isShared/accountName` (`lib/jmap/client.ts:4718-4733, 4756-4793, 5036-5070`); sidebar renders "Shared from X" sections (`components/contacts/contacts-sidebar.tsx:160-176, 562-603`); create/update/move de-namespace ids and pick the right account (`stores/contact-store.ts:473-527, 529-561, 926-978`); changelog 1.8.x "Require an explicit shared-account fallback for contacts and calendars".
  - What RN does: single-account only (`src/api/contacts.ts` throughout); `AddressBook` type has no `accountId/isShared` (`src/api/types.ts:369-377`).
  - Fix hint: iterate `session.accounts` where `accountCapabilities[contacts]` or `!isPersonal` (as WEB `getContactCapableAccountIds`), namespace ids, and render a "Shared from" section in `ContactsSidebarDrawer`; route writes to the owning account. The `myRights.mayWrite` checks already present in `AddressBookPickerSheet:96` and `ContactsSettings:204,209` will then become meaningful.

- [x] **Deleting a contact does not clean group member references locally** — `P3` — `partial` — fixed in 26a34d5
  - Drawer member counts resolve through `selectGroupMembers` in 358bdb9.
  - What WEB does: `cleanGroupMembers` strips the deleted card's id/uid/`urn:uuid:` variants from every group's `members` in state on delete/bulk delete (`stores/contact-store.ts:339-366, 571-578, 911-918`).
  - What RN does: `deleteContact`/`bulkDelete` just filter the list (`src/stores/contacts-store.ts:185-195`); group counts in the drawer use raw `Object.keys(g.members).length` (`src/components/contacts/ContactsSidebarDrawer.tsx:150`) so they keep counting deleted members until the next full refresh.
  - Fix hint: port `cleanGroupMembers`; resolve drawer counts through `selectGroupMembers` like WEB `memberCountByGroup` (`contacts-sidebar.tsx:250-270`).

- [x] **Deleting an address book leaves its contacts in the cache** — `P3` — `partial` — fixed in 26a34d5
  - What WEB does: `removeAddressBook` drops contacts filed in that book from state (`stores/contact-store.ts:1053-1056`).
  - What RN does: strips the book id but keeps the cards (`src/stores/contacts-store.ts:260-276`), so they show under "All"/"Uncategorized" until a refresh; the confirm text ("will be removed from this book") also implies they survive (`src/components/settings/ContactsSettings.tsx:282`).
  - Fix hint: filter out cards whose only book was the deleted one, or call `fetchContacts()` after the destroy.

- [x] **Persisting every contact card (incl. base64 photos) to AsyncStorage** — `P3` — `rn-only-bug` — fixed in 26a34d5
  - `media` is stripped from the persisted snapshot; picked photos are downscaled to 512px JPEG with `expo-image-manipulator` in 9800ad0.
  - What RN does: `partialize` persists `contacts` and `addressBooks` (`src/stores/contacts-store.ts:355-366`); cards carry inline `data:` photos (`src/screens/ContactFormScreen.tsx:690-691` stores the picked image as base64 with no downscale). Android AsyncStorage's default 6 MB cap will make the write fail for a few hundred photo contacts and the cache silently stops updating.
  - Fix hint: strip `media` from the persisted snapshot (re-hydrate photos from the server) and/or downscale photos on pick (WEB caps at 512px JPEG q0.85, `components/contacts/contact-form.tsx:96-126`).

### Address books

- [x] **Set default address book missing** — `P3` — `missing` — fixed in bc4c57e
  - `setDefaultAddressBook` (onSuccessSetIsDefault) and the `isDefault`-free update patch landed in 580e010; new contacts/imports prefer the default book via `getDefaultAddressBookId`.
  - What WEB does: context-menu "Set as default" uses `AddressBook/set onSuccessSetIsDefault` (`components/contacts/contacts-sidebar.tsx:612-663`, `lib/jmap/client.ts:4851-4869`, `stores/contact-store.ts:1017-1044`), and the create form preselects the default book (`components/contacts/contact-form.tsx:362-367`).
  - What RN does: no UI; `updateAddressBook` even forwards `isDefault` as a patch property (`src/api/contacts.ts:117,122`) which WEB notes is read-only and fails the whole update (`lib/jmap/client.ts:4819-4821`). New contacts/imports default to `addressBooks[0]` (`src/screens/ContactFormScreen.tsx:581,591-593`; `src/screens/ContactsScreen.tsx:201-204`; `src/components/settings/ContactsSettings.tsx:54`).
  - Fix hint: add `setDefaultAddressBook` (onSuccessSetIsDefault) to `api/contacts.ts` + a row action in `ContactsSettings`; drop `isDefault` from the update patch; prefer `books.find(b => b.isDefault)` as the default target.

- [x] **Default address book can be offered for deletion** — `P3` — `partial` — fixed in bc4c57e
  - What WEB does: hides delete for `isDefault`/shared books (`components/contacts/contacts-sidebar.tsx:615`).
  - What RN does: shows the trash icon whenever `books.length > 1 && mayDelete !== false` (`src/components/settings/ContactsSettings.tsx:209`); the server then rejects and the user sees a raw error.
  - Fix hint: add `!book.isDefault` to the guard.

- [ ] **Address book share / visibility (subscription) management missing** — `P3` — `missing`
  - deferred: `shareWith`/`myRights` are now requested explicitly (580e010) and typed on `AddressBook`; no sharing sheet on mobile yet (reuse the calendar-sharing sheet when it exists).
  - What WEB does: `shareAddressBook` via `shareWith/<principal>` patch + ShareCollectionDialog (`stores/contact-store.ts:1064-1085`, `components/contacts/contacts-app.tsx:1142-1158`); sidebar shows a shared indicator (`contacts-sidebar.tsx:879-881`).
  - What RN does: nothing; `getAddressBooks` requests no `properties` so `shareWith` is whatever the server defaults to (`src/api/contacts.ts:17-24`; WEB requests `ADDRESS_BOOK_PROPERTIES` incl. `shareWith`, `lib/jmap/client.ts:252-261`, #257).
  - Fix hint: low priority on mobile; if added, reuse whatever calendar-sharing sheet the calendar agent proposes and request `properties` explicitly.

### Contact card / form

- [x] **Clearing a whole field group on edit never reaches the server** — `P2` — `rn-only-bug` — fixed in 9800ad0
  - What RN does: `formToPatch` only includes keys that are non-empty (`src/screens/ContactFormScreen.tsx:378-395`), and `updateContact` sends the patch as a JMAP `update` (`src/api/contacts.ts:82`). Removing the last phone/address/note/keyword/anniversary/online link of an existing contact therefore omits the key, which JMAP treats as "unchanged"; the store merge (`contacts-store.ts:178-182`) also keeps the old value, so the UI shows the removed items again.
  - Fix hint: in edit mode emit `null` for every collection the form owns that ended up empty (emails, phones, addresses, organizations, titles, anniversaries, onlineServices, personalInfo, notes, keywords, nicknames, speakToAs, calendarUri…) — the same approach WEB uses for `media: null` (`components/contacts/contact-form.tsx:555-558`).

- [x] **Saving the form drops non-photo media (logo, sound)** — `P3` — `rn-only-bug` — fixed in 9800ad0
  - What WEB does: copies every non-photo `media` entry through and keeps the original photo key (`components/contacts/contact-form.tsx:544-553`).
  - What RN does: rebuilds `media` with only `media.photo` (`src/screens/ContactFormScreen.tsx:359-366,395`), so an imported LOGO/SOUND is deleted on the first edit.
  - Fix hint: carry `existing.media` entries with `kind !== 'photo'` into the patch.

- [x] **Anniversary input accepts free text that the server rejects; year-only dates get a fake Jan 1** — `P2` — `rn-only-bug` — fixed in 9800ad0
  - `stringToPartialDate` / lossless `partialDateToString` live in `src/lib/contact-utils.ts` (580e010).
  - What WEB does: `<input type="date">` plus `stringToPartialDate` always yields a structured PartialDate (`components/contacts/contact-form.tsx:192-206, 525-528`); changelog 1.9.x #224 stresses that Stalwart drops non-PartialDate anniversaries.
  - What RN does: `stringToAnniversaryDate` returns the raw string for anything other than `YYYY-MM-DD` / `--MM-DD` (`src/screens/ContactFormScreen.tsx:116-128`), so "1990-05", "May 5" or a `YYYY-MM-DDT…` value is sent as a string → Stalwart rejects the set (and, via the previous finding, the failure is invisible). `partialDateToString` pads a year-only or year-month PartialDate with `01` (`:110`), so merely opening and saving a contact with `{year:1990}` rewrites it to 1990-01-01 — this feeds the birthday calendar with a wrong day.
  - Fix hint: reject/normalise input to PartialDate (support `YYYY`, `YYYY-MM`, `--MM-DD`, `---DD` like WEB `parseVcardDate`, `lib/vcard.ts:360-394`), and make `partialDateToString` lossless (`1990`, `1990-05`).

- [x] **Organization-kind cards (#701)** — `P3` — `partial` — fixed in 9800ad0
  - Detail subtitle no longer repeats the org name (1cef53a).
  - What WEB does: person/organization toggle, org name validates as the identity, `name.full` filled from org, `kind: 'org'` written, detail hides the duplicated org line (`components/contacts/contact-form.tsx:269-277, 443-449, 491-495, 560-563, 696-735`; `components/contacts/contact-detail.tsx:178-180`).
  - What RN does: no toggle/kind; validation requires given/surname/full or an email (`src/screens/ContactFormScreen.tsx:607-612`), so an org card needs its name typed into "Display name" and an org-only card without email cannot be created; detail subtitle repeats the org under the heading when they are equal (`src/screens/ContactDetailScreen.tsx:136`).
  - Fix hint: add a Person/Organization pill in the Identity section; when org: skip name components, set `name.full = org`, `kind: 'org'`, accept org name as identity; hide the equal subtitle.

- [x] **Photo data URIs from Stalwart not normalised (#307)** — `P2` — `bugfix-parity` — fixed in 580e010
  - What WEB does: `normalizeContactPhotoUri` rewrites `data:base64,…` / `data:;base64,…` to `data:image/jpeg;base64,…` in `getContactPhotoUri` and in the form (`stores/contact-store.ts:157-180`; `contact-form.tsx:376`).
  - What RN does: `getContactPhotoUri` returns `media.uri` raw (`src/lib/contact-utils.ts:71-77`), used by `ContactListRow:38`, `ContactDetailScreen:114` and the form (`ContactFormScreen.tsx:233-237`); RN `Image` cannot decode a media-type-less data URI so such photos render blank, and re-saving writes the malformed URI back.
  - Fix hint: port `normalizeContactPhotoUri` into `contact-utils.ts` and apply in `getContactPhotoUri` + `contactToForm`.

- [x] **Picked photos are stored full-size** — `P3` — `partial` — fixed in 9800ad0
  - What WEB does: downscales to 512px JPEG before embedding (`components/contacts/contact-form.tsx:96-126`) and rejects files >10 MB.
  - What RN does: `ImagePicker` with `quality: 0.8`, no dimension cap, base64 straight into the card (`src/screens/ContactFormScreen.tsx:680-695`).
  - Fix hint: use `expo-image-manipulator` to resize to ≤512px before reading base64.

- [x] **Duplicate contact keeps the source UID** — `P2` — `rn-only-bug` — fixed in 1cef53a
  - What WEB does: strips `id`, `uid`, `created`, `updated` before creating the copy (`components/contacts/contacts-app.tsx:448-451`).
  - What RN does: `doDuplicate` only strips `id/addressBookIds/created/updated` (`src/screens/ContactDetailScreen.tsx:216-222`), so the copy is created with the same `uid`; group membership by uid then matches both cards and CardDAV/vCard consumers see two cards with one UID.
  - Fix hint: also drop `uid` (and let `createContact` mint a fresh one once the #644 fix lands).

- [x] **Gender vocabulary differs from WEB and from the vCard exporter** — `P3` — `partial` — fixed in 9800ad0
  - What WEB does: `masculine | feminine | other | none | unknown` (vCard SEX mapping, `components/contacts/contact-form.tsx:1062-1069`), which `grammaticalGenderToVcardSex` understands (`lib/vcard.ts:34-48`).
  - What RN does: `masculine | feminine | common | neuter | animate | inanimate` (`src/screens/ContactFormScreen.tsx:437-445`); values other than masculine/feminine export as an empty GENDER and display differently across clients.
  - Fix hint: align option lists (or accept both on display) so the same card renders the same value in both apps.

- [x] **Online service `label` and multiple nicknames not editable** — `P3` — `partial` — fixed in 9800ad0
  - Detail shows every nickname (1cef53a).
  - What WEB does: online-service entries carry `label` (`contact-form.tsx:24-28, 517-523`); detail shows all nicknames (`contact-detail.tsx:194-196`).
  - What RN does: `OnlineDraft` has only `uri/service` (`src/screens/ContactFormScreen.tsx:42, 332-338`), and the form/detail read only the first nickname (`:168-170, 269-270`; `src/lib/contact-utils.ts:171-174`). Saving a card with several nicknames collapses them to one.
  - Fix hint: keep unknown nicknames when rebuilding `nicknames`, add a label field to the online row.

- [x] **Display name includes the middle name (differs from WEB sorting/grouping)** — `P3` — `partial` — fixed in 580e010
  - What WEB does: `given + surname` only, then `name.full`, nickname, org, email (`stores/contact-store.ts:125-150`).
  - What RN does: `given + middle + surname` (`src/lib/contact-utils.ts:13-14`). Harmless on its own but sort order, dedupe keys and `#672`-style name sanitising diverge between clients.
  - Fix hint: drop `middle` from the join or make it a display-only concern.

### List, search, sort

- [x] **Alphabetical index buckets every non-ASCII initial under "#"** — `P3` — `bug` — fixed in 358bdb9
  - What WEB does: `\p{L}` test + `Intl.Collator(locale, sensitivity base)` so Ä/É/Ł get their own sections (`components/contacts/contact-list.tsx:242-262`).
  - What RN does: `/[A-Z]/.test(letter)` (`src/screens/ContactsScreen.tsx:53-54`), so "Éric" and "Ölçer" land in "#".
  - Fix hint: use `/\p{L}/u` and `localeCompare` (Hermes supports Unicode property escapes).

- [x] **"Uncategorized" means "no address book" in RN but "no category" in WEB, and its count is hard-coded 0** — `P3` — `bug` — fixed in 358bdb9
  - `selectUncategorized` (no keywords) in 26a34d5; the drawer row moved under Tags as "No category" with a live count.
  - What WEB does: "No category" = contacts without keywords, with a live count (`components/contacts/contacts-sidebar.tsx:246-248, 526-541`; `contacts-app.tsx:283-285`).
  - What RN does: filter = contacts with no `addressBookIds` (`src/stores/contacts-store.ts:439-440`; `src/screens/ContactsScreen.tsx:146-149`), drawer row passes `count={0}` (`src/components/contacts/ContactsSidebarDrawer.tsx:128-136`) so the count never shows; on Stalwart every card has a book so the view is always empty.
  - Fix hint: redefine as "no keywords", move the row under the Tags section, compute the count.

- [ ] **Contact list filters (org / title / location / domain / birthday month / has email-phone-photo) missing** — `P3` — `missing`
  - deferred: optional; free-text search only.
  - What WEB does: filter drawer with tri-state chips (`components/contacts/contact-list.tsx:18-76, 154-228, 350-456`; changelog 1.5.x "Revamp contact detail view with filters").
  - What RN does: free-text search only (`src/lib/contact-utils.ts:216-241`).
  - Fix hint: optional; a filter sheet reusing the WEB predicate block would do.

- [x] **No select-all / bulk export in multi-select** — `P3` — `partial` — fixed in 358bdb9
  - What WEB does: select-all toggle, range select, bulk export, bulk add-to-group (`components/contacts/contact-list.tsx:283-305, 458-502`).
  - What RN does: long-press multi-select with delete / move / tag only (`src/screens/ContactsScreen.tsx:164-226, 282-313`).
  - Fix hint: add "Select all visible" and "Export selected" (reuse `contactsToVCard` + share flow from `ContactsSettings:56-78`).

- [x] **Rename category (keyword) missing** — `P3` — `missing` — fixed in 358bdb9
  - `renameKeyword` in the store (26a34d5); long-press a tag in the drawer to rename.
  - What WEB does: keyword context menu → rename, rewrites `keywords` on every affected card (`components/contacts/contacts-sidebar.tsx:680-698`; `stores/contact-store.ts:1087-1116`).
  - What RN does: tags can be assigned/removed per contact and in bulk (`TagAssignSheet`, `contacts-store.ts:213-235`) but not renamed.
  - Fix hint: long-press on a Tags row in `ContactsSidebarDrawer` → prompt → loop `updateContact` like WEB `renameKeyword`.

- [x] **Add-to-group from the contact itself missing** — `P3` — `partial` — fixed in 1cef53a
  - What WEB does: detail "More" menu and list context menu offer "Add to group" (creating a group if none) (`components/contacts/contacts-app.tsx:438-446`; `contact-detail.tsx:150-152`).
  - What RN does: membership is only editable from `GroupDetailScreen` (`src/screens/GroupDetailScreen.tsx:86-98`); the detail "More" sheet has Duplicate/Move/Export/Delete only (`src/screens/ContactDetailScreen.tsx:247-270`).
  - Fix hint: add a "Add to group" item that opens a group picker (list of `selectGroups`) and calls the same `members` patch as `GroupDetailScreen.addMembers`.

### Groups

- [x] **No way to create a contact group** — `P2` — `missing` — fixed in 9800ad0
  - "New group" row in the drawer and long-press on the header "+" (358bdb9); `createGroup`/`memberIds` route param.
  - What WEB does: "+" menu → "Create group" with name + member picker (`components/contacts/contacts-sidebar.tsx:299-305`; `contact-group-form.tsx`; `stores/contact-store.ts:734-760`).
  - What RN does: `ContactForm` supports `asGroup` (`src/screens/ContactFormScreen.tsx:554,627`) but the only caller passes an existing `contactId` for editing (`src/screens/GroupDetailScreen.tsx:138`; grep `asGroup` in `src/`: no other call site). The Contacts header "+" always opens a plain new-contact form (`src/screens/ContactsScreen.tsx:336-343`).
  - Fix hint: add "New group" to the header/drawer that navigates to `ContactForm { asGroup: true }` with a members picker (`ContactPickerSheet`), or a dedicated small screen that creates `{ kind:'group', name:{components:[{kind:'given', value}]}, members }`.

- [x] **Group edit reuses the full person form (name split into first/last, photo, emails…)** — `P3` — `partial` — fixed in 9800ad0
  - What WEB does: dedicated group form with name + searchable member checklist (`components/contacts/contact-group-form.tsx:80-196`).
  - What RN does: `GroupDetailScreen` → `ContactForm asGroup` shows Prefix/First/Middle/Last/Nickname, Email, Phone… (`src/screens/ContactFormScreen.tsx:747-813`); a group named "Sales Team" appears in "First name".
  - Fix hint: when `asGroup`, render a single "Group name" field bound to `given` and hide the person-only sections.

- [x] **Group compose: RN expands to individual recipients; no To/Cc/Bcc choice** — `P3` — `partial` — fixed in 1cef53a
  - Dedupe via `getGroupRecipients` (26a34d5); a single group chip is up to the composer agent.
  - What WEB does: hands the composer one expandable group chip (RFC 5322 group syntax) with a To/Cc/Bcc submenu (`components/contacts/contacts-app.tsx:561-587`; `contact-group-detail.tsx:69-87`; changelog 1.7.x "Contact groups as single expandable recipient chips").
  - What RN does: "Email all" pushes one recipient per member into `prefillTo` (`src/screens/GroupDetailScreen.tsx:72-84`). Functionally fine; dedupe by email is missing (two members sharing an address are both added).
  - Fix hint: dedupe case-insensitively; a group chip is optional unless the composer agent adds group chips.

### Composer autocomplete

- [ ] **Autocomplete lacks groups, recent recipients (Sent), on-demand server search and directory principals** — `P2` — `missing`
  - store-side done in 26a34d5 (`getAutocomplete` with group entries + recent recipients, `loadRecentRecipients`/`searchRecipients` fed by `src/api/recent-recipients.ts`, `getGroupRecipients`, #672 normalisation); wiring `ComposeScreen`/`ParticipantInput` belongs to the composer agent; directory principals not ported.
  - What WEB does: `getAutocomplete` merges contacts, group entries (as one chip with `memberCount`), RFC 9670 directory principals and recent Sent recipients, deduped and sanitised (#672) (`stores/contact-store.ts:622-707, 23-49`; `loadRecentRecipients` `:1118-1142` fed from `mail-app.tsx:423`; `searchRecipients` `:1144-1154` used by `components/email/email-composer.tsx:1175-1212`; group chip insertion `:1218-1233`; changelogs 1.6.x "Recipient autocomplete from Sent, with on-demand server search", 1.7.x group chips).
  - What RN does: suggestions come only from `individuals` matched with `matchesContactSearch` (`src/screens/ComposeScreen.tsx:367-392`); groups are explicitly filtered out and nothing else is consulted. `ParticipantInput` (calendar) likewise flattens contacts only (`src/components/calendar/ParticipantInput.tsx:34-51`).
  - Fix hint: add `recentRecipients` (scan Sent `to/cc`, 300 msgs) to the contacts store, include groups as a pickable entry that expands to member emails on pick, and reuse `sanitizeDisplayName/splitMailbox`-style cleanup for names that contain a mailbox (#672).

### Viewer integration

- [x] **"Add sender to contacts" from the message view missing** — `P2` — `missing` — done in d2ed27f (the viewer's address sheet, `src/components/email/AddressActionSheet.tsx`, offers "Add to contacts" and "Open contact")
  - contact-side done: `ContactForm { prefill }` seeds email + given/surname (9800ad0), `findContactByEmail` in the store (26a34d5); the sender sheet in `EmailThreadScreen` belongs to the viewer agent.
  - What WEB does: contact sidebar/popover on sender click with "Add to contacts" that creates a card with given/surname split from the display name (`components/email/email-viewer.tsx:5350-5366, 558-564`); also the mobile recipient popover (#306) and `/contacts/new?addEmail=` deep link (`components/contacts/contacts-app.tsx:182-198`).
  - What RN does: no contact lookup or "add" action in `EmailThreadScreen` (grep contact/ContactForm: only `SenderAvatar` at `:794`). Only `ContactForm`'s `route.params` support `contactId/addressBookId/asGroup` (`src/navigation/types.ts:24`) — no email/name prefill.
  - Fix hint: add `prefill?: { email; name }` to the `ContactForm` route, and a sender-tap sheet in `EmailThreadScreen` with "Add to contacts" / "Open contact" (lookup by email in `useContactsStore`).

- [ ] **Sender-name tap → contact popup missing** — `P3` — `missing`
  - deferred: viewer agent (same sheet as above; `findContactByEmail` + `ContactDetail { contactId }` are ready).
  - What WEB does: clicking the sender name opens the contact popup with details/actions (changelog 1.4.x "Show contact popup when clicking the sender name", `email-viewer.tsx:392-455`).
  - What RN does: none (see previous item).
  - Fix hint: same sheet as above; show the matching card's phone/org and an "Open" that navigates to `ContactDetail`.

- [ ] **Contact deep links (`/contacts/<id>[/edit]`, `/contacts/new`)** — `P3` — `missing`
  - partly: `/contacts/<id>` opens the contact since 5802cae; `/contacts/new` and `/contacts/<id>/edit` only open the Contacts tab.
  - What WEB does: `parseContactsPath`/`buildContactsPath` (`lib/deep-links.ts:323-329`), applied once on mount (`components/contacts/contacts-app.tsx:182-224`).
  - What RN does: `src/navigation/linking.ts` (5802cae) maps `/contacts/<id>` to `ContactDetail { contactId }` and every other contacts path to the tab; it never opens `ContactForm`.

### vCard import / export (`lib/vcard.ts` vs `src/lib/vcard.ts`)

- [x] **Imported dates are raw strings, not RFC 9553 PartialDate (#224) — birthdays vanish on Stalwart** — `P1` — `bugfix-parity` — fixed in e650cb2
  - What WEB does: `parseVcardDate` converts BDAY/ANNIVERSARY/DEATHDATE/X-ABDATE (basic + extended forms, reduced accuracy, `VALUE=text` skipped) into `{year, month, day}` and drops undecodable dates (`lib/vcard.ts:360-394`, `addAnniversary` in `buildContact` ~`:480-490`; changelog 1.9.x "Import vCard dates as RFC 9553 PartialDate and map common X- extensions (#224)").
  - What RN does: `card.anniversaries.a0 = { kind: 'birth', date: val }` with the raw string (`src/lib/vcard.ts` BDAY case ~`:687`, ANNIVERSARY ~`:701`, DEATHDATE ~`:709`), so every imported birthday is rejected by Stalwart (the whole `ContactCard/set` create fails with invalidProperties, and because of the error-handling finding above the failure is reported only as a generic "import failed for one contact" warning) — i.e. importing a vCard with a BDAY loses the entire contact, not just the date.
  - Fix hint: copy `parseVcardDate` + `addAnniversary` from WEB into RN `vcard.ts`; add a test with `BDAY:19850412`, `BDAY:--0412`, `BDAY;VALUE=text:circa 1800`.

- [x] **Vendor X- extensions not imported (X-ABDATE, X-ABRELATEDNAMES, X-SPOUSE/MANAGER/ASSISTANT, X-MAIDENNAME, X-GENDER, X-ANDROID-CUSTOM, X-AIM/X-SKYPE/… IM handles)** — `P2` — `bugfix-parity` — fixed in e650cb2
  - What WEB does: `X_ONLINE_SERVICES` map → onlineServices, `RELATION_LABELS`/`ANDROID_RELATION_TYPES` → relatedTo, `ANDROID_EVENT_KINDS` → anniversaries, X-MAIDENNAME → `surname2`, X-GENDER → grammaticalGender (`lib/vcard.ts:250-323, ~1009-1100, ~1113-1120`); export writes `X-MAIDENNAME` and `X-ABDATE` for `other` anniversaries (`~1173-1178, ~1280-1283`).
  - What RN does: `default: break` (`src/lib/vcard.ts:~858`); none of the maps exist (function list: no `X_ONLINE_SERVICES`, `RELATION_LABELS`, `ANDROID_*`). Export skips `surname2` and `other` anniversaries (`~:1025-1045`).
  - Fix hint: port the maps and the extension cases verbatim; both files otherwise share structure so a near-mechanical diff apply works.

- [x] **Apple grouped labels (`item1.TEL` + `item1.X-ABLABEL`) are lost** — `P2` — `bugfix-parity` — fixed in e650cb2
  - What WEB does: `splitGroupPrefix` keeps the group, `collapseProperties` folds a sibling `X-ABLABEL` into an `X-ABLABEL=` param, `decodeAppleLabel` strips `_$!<…>!$_` (`lib/vcard.ts:116-140, 413-434`); labels then land on emails/phones/addresses/online services.
  - What RN does: `stripGroupPrefix` discards the group (`src/lib/vcard.ts:120-131`) and properties are keyed by `keyPart` only (`:334-339`), so iOS/macOS exports lose every custom label and the `X-ABLABEL` lines are silently dropped (`:~854`).
  - Fix hint: port `splitGroupPrefix` + `collapseProperties` + `RawProperty` list handling in `parseVCard`.

- [x] **Org-only vCards are dropped on import and exported without FN (#701)** — `P2` — `bugfix-parity` — fixed in e650cb2
  - What WEB does: `hasOrg` counts as identity in `buildContact` (`lib/vcard.ts:~1123-1127`); `generateSingleVCard` falls back to the org name for the mandatory FN (`~:1158-1162`).
  - What RN does: `if (!hasName && !hasEmail && card.kind !== 'group') return null` (`src/lib/vcard.ts:~893-895`) so a company card with only ORG+TEL is skipped; export emits no `FN`/`N` when there is no personal name (`~:932-936`), producing an invalid vCard (FN is required by RFC 6350) that the RN importer itself would then reject.
  - Fix hint: apply the two WEB lines.

- [x] **Only one NICKNAME survives import** — `P3` — `bugfix-parity` — fixed in e650cb2
  - What WEB does: `card.nicknames[\`n${idx}\`]` (`lib/vcard.ts` NICKNAME case).
  - What RN does: `card.nicknames.n0 = { name: val }` overwrites (`src/lib/vcard.ts` NICKNAME case ~`:548`).
  - Fix hint: index like WEB.

- [x] **Import target defaults to the first book and cannot be changed from Settings** — `P3` — `partial` — fixed in bc4c57e
  - What WEB does: `client.createContact` without `addressBookIds` files into the `isDefault` book (`lib/jmap/client.ts:5095-5101`).
  - What RN does: `ContactsSettings` passes `books[0]` with no `onChangeTarget` (`src/components/settings/ContactsSettings.tsx:54, 269-275`); `ContactsScreen` allows changing the target but also starts at `addressBooks[0]` unless a book category is active (`src/screens/ContactsScreen.tsx:201-204, 476, 480-486`).
  - Fix hint: prefer `isDefault`; pass `onChangeTarget` in settings too.

- [x] **Import keeps the source UID (fine) but nothing mints one when absent** — covered by the #644 finding above; also `importContacts` swallows per-card failures with only a `console.warn` (`src/stores/contacts-store.ts:206-208`) so "Imported 0 contacts" is the only feedback. `P3` — add a failure count to the result sheet. — fixed in 26a34d5
  - The result sheet now shows how many cards failed to import.

### Trusted senders

- [x] **Trusted-senders settings show only the local list; synced book entries are invisible and cannot be removed** — `P2` — `partial` — fixed in 78114b6
  - What WEB does: modal shows the address-book entries when the feature is on, adds/removes through `addToTrustedSendersBook`/`removeFromTrustedSendersBook`, and settings show the synced count (`components/trusted-senders-modal.tsx:22-48`; `components/settings/content-senders-settings.tsx:25-40, 77-82`).
  - What RN does: `ContentSendersSettings` reads/writes only `settings-store.trustedSenders` (`src/components/settings/ContentSendersSettings.tsx:19-21, 100-144`); `removeFromTrustedSendersBook` exists in the store (`src/stores/contacts-store.ts:323-333`) but has no caller. A sender trusted from the viewer is written to both places (`src/components/EmailBodyView.tsx:644-651`), so deleting it in settings only removes the local copy and the book keeps trusting it (`EmailBodyView.tsx:513-516`).
  - Fix hint: in the modal, list `trustedSenders ∪ trustedSenderEmails`, mark book entries, and call `removeFromTrustedSendersBook` (+ local remove) on delete; show the union count.

- [x] **`trustedSendersAddressBook` setting is dead (`false`, no setter, no toggle) — book is consulted unconditionally** — `P3` — `partial` — fixed in 78114b6
  - Setting is `boolean | null` with a "Sync trusted senders to address book" toggle. Until d89e331 it switched itself on for a contacts-capable account, and the viewer then trusted every contact in every book; it now stays off until the user turns it on, and only the Trusted Senders book counts (the webmail still auto-enables it).
  - What WEB does: `null` until the account proves contacts support, then auto-`true` (`stores/auth-store.ts:380-385`, `stores/settings-store.ts:361,593`); toggle in settings (`content-senders-settings.tsx:77-82`); the book is only loaded/used when enabled (`mail-app.tsx:199-203`, `email-viewer.tsx:1705`).
  - What RN does: default `false`, no setter (`src/stores/settings-store.ts:106,239`); `EmailBodyView` loads the book regardless and ORs `trustedSenderEmails` into the trust check (`:480-485, 513-516`); the `addressBookEmails` branch (treats *every* contact as trusted) is gated on the dead flag (`:486-498`) so it never runs.
  - Fix hint: either drop the flag and the dead `addressBookEmails` branch, or expose a "Sync trusted senders to address book" toggle that gates the passive load and the `addToTrustedSendersBook` write.

- [x] **Race: trusting a sender while the passive book load is in flight silently fails** — `P2` — `rn-only-bug` — fixed in 26a34d5
  - What WEB does: single-flight promise shared by all callers (`stores/contact-store.ts:184-185, 1156-1199`), so `addToTrustedSendersBook` awaits the load and then has a `bookId`.
  - What RN does: `loadTrustedSendersBook` returns immediately when `trustedSendersLoading` is true (`src/stores/contacts-store.ts:279`); `addToTrustedSendersBook` then reads `bookId === null` and throws (`:312-317`), which the viewer swallows (`EmailBodyView.tsx:650`). The passive load is kicked off by the same screen a moment earlier (`:483-485`), so the very first "Trust sender" after app start is likely to hit this.
  - Fix hint: keep the in-flight promise in a module variable and return it; if the passive load found no book and `createIfMissing` is true, create it after the await.

- [x] **Duplicate "Trusted Senders" books are not consolidated and the pick is non-deterministic (#730)** — `P3` — `bugfix-parity` — fixed in 26a34d5
  - Deterministic pick (sorted by id); consolidation not ported.
  - What WEB does: sorts matches by id, uses the first, merges the rest and deletes them (`stores/contact-store.ts:1169-1187, 208-245`); `getAddressBooks({throwOnError})` prevents minting on a failed fetch.
  - What RN does: `books.find(b => b.name === …)` (`src/stores/contacts-store.ts:283`) — order-dependent; if the web already created a duplicate pair, RN may trust a different subset than web. RN only creates on explicit add (`:284-290`) and `fetchAddressBooks` throws on error, so RN itself does not mint duplicates.
  - Fix hint: sort by id before picking; optional consolidation.

- [x] **Trusted-sender card stores no display name; "Name <email>" input not parsed** — `P3` — `partial` — fixed in 26a34d5
  - What WEB does: parses `Name <email>` and stores `name.full` (`stores/contact-store.ts:1201-1225`).
  - What RN does: lower-cases the whole string and stores `emails` only (`src/stores/contacts-store.ts:308-321`); a `Name <email>` string (e.g. typed in settings) becomes an invalid address.
  - Fix hint: reuse the WEB regex.

- [x] **Auto-trust reply recipients missing** — `P3` — `missing` — done in 5b72c4d (area 04)
  - deferred: composer agent; `addToTrustedSendersBook` now accepts `Name <email>` and never races the passive load (26a34d5).
  - What WEB does: on reply/replyAll every To/Cc recipient is added to the trusted book (`components/email/email-composer.tsx:2284-2292`; changelog 1.4.x "Auto-add recipients to trusted senders when replying").
  - What RN does: `ComposeScreen` has no trusted-sender code (grep `trusted`: none).
  - Fix hint: after a successful send in reply mode call `addToTrustedSendersBook` (+ `addTrustedSender`) for each outgoing To/Cc.

### Activity / misc

- [x] **Contact activity: upcoming events come only from the already-loaded calendar cache** — `P3` — `partial` — fixed in 0e51465
  - What WEB does: queries the server for the next 365 days (`components/contacts/contact-activity.tsx:133-169`).
  - What RN does: filters `useCalendarStore().events` (`src/components/contacts/ContactActivity.tsx:90-91, 127-142`), i.e. only the range the calendar tab happened to load; on a fresh start it is empty.
  - Fix hint: call the RN calendar API for `[now, now+365d]` with a participant filter, falling back to the cache.

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Address book list/create/rename/delete with `myRights` checks (`src/components/settings/ContactsSettings.tsx`, `AddressBookPickerSheet`); inline "New address book…" in the move sheet (WEB #415).
- Move contacts between books (single from detail, bulk from list) via `addressBookIds` patch (`contacts-store.ts:237-241`) — RN equivalent of WEB drag-and-drop.
- Group by first letter with sticky headers + settings toggle (`ContactsScreen.tsx:158-162`, `ContactsSettings.tsx:132-137`); sort by display name.
- Search over name/emails/phones/orgs (RN also matches keywords).
- Detail screen renders every WEB field block: emails/phones with contexts+features+labels, addresses (components, flat, timezone), org/units/titles/roles, anniversaries with age, gender/pronouns, languages, personalInfo, online services, calendar URIs, crypto keys, categories, relatedTo, notes, address book names, created/updated; quick actions call/SMS/mail/share; copy via long-press.
- Contact form: prefix/given/middle/surname/suffix, nickname, display name (`name.full`), multiple emails/phones with context + phone feature pills, addresses as RFC 9553 components, multiple orgs (org/department/title/role), anniversaries with native date picker, online services, personalInfo w/ level, gender+pronouns, calendar URIs, categories (chips + suggestions from existing keywords), multiple notes, photo pick/remove, address book pick, dirty-state discard confirm, email regex validation, `media: {}` when photo removed (equivalent of WEB `media: null`).
- `name.full` display fallback (#179), `getContactPrimaryEmail` with `pref`.
- Group detail: member list resolved via id/uid/`urn:uuid:` (`contacts-store.ts:401-415`), add members via `ContactPickerSheet`, remove member, delete group, email all.
- Tags (keywords) = WEB categories: drawer section with counts, filter by tag, bulk assign via `TagAssignSheet`, per-contact edit in form.
- vCard import sheet: file picker, 5 MB cap, parse, duplicate detection by email (`detectDuplicates` identical), select all/none, target book, result count; export all (settings) and single (detail) with share sheet; multi-vCard files; QUOTED-PRINTABLE + charset decode (RN has a Hermes-safe `decodeBytes`), RFC 6868 params, KIND/MEMBER, PHOTO/LOGO/SOUND, RFC 6474/6715/8605/9554 properties.
- Contact activity: recent emails via `from/to` OR filter (limit 5), opens the thread.
- Trusted senders: same book name constant, passive load, add on "Trust sender" in the viewer, `isTrustedAddressBookSender` check.
- Contacts tab hidden when the session lacks `urn:ietf:params:jmap:contacts` (`src/lib/capabilities.ts:29-31`, `App.tsx:170-179`) — WEB 1.8.x "Hide Contacts and Calendars when the account lacks the JMAP capability".
- Push `StateChange` for `AddressBook`/`ContactCard` triggers refetch (`contacts-store.ts:152-168`, `App.tsx:390-396`); contacts cache persisted for instant render; selected category persisted.
- Contact store reset on logout/account switch (`src/stores/auth-store.ts:58,76,113,179,379`) — the RN counterpart of the 583e20d9 namespacing fix (single-account store, so no id-form flip).

## N/A on mobile
- Pro multi-account aggregation (`hooks/use-pro-multi-account-contacts.ts`, `fetchAllAccountsContacts`, `::` id namespacing) — Pro shell only; RN keeps one account active and resets the store on switch.
- Local-storage (non-JMAP) contact fallback (`supportsSync === false`, `local-<uuid>` ids) — RN hides the tab when contacts are unsupported.
- Drag-and-drop to address books / categories, right-click context menus, Ctrl/Shift range selection, resizable panes, keyboard shortcuts — replaced by long-press multi-select + sheets.
- Print contact (`components/contacts/contact-print.ts`).
- Plugin contact APIs and the `contact-cryptokeys` plugin slot.
- `mailto:`/`tel:` handoff differences (RN uses `Linking`).
- Native issue #34 (device contacts / calendar sync adapters) is a feature request, not a parity item; note that a device sync would want the UID (#644) and PartialDate (#224) fixes above first.
