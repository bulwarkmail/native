# Settings sync

The app keeps its settings in the private Inbox metadata of one account, so every device signed in to
that account has the same ones (#117). This page is the format, for any client that wants to read and
write the same entries, and the rules the app follows.

Code: `src/lib/settings-sync.ts` (format and merge, pure), `src/stores/settings-sync-store.ts`
(rounds and requests), `src/api/bulwark-metadata.ts` (the metadata requests).

## Where it is stored

JMAP Metadata (`urn:ietf:params:jmap:metadata`) on the account's Inbox, in vendor namespaces under
`org.bulwarkmail.`, in the **`privateMetadata`** property. Stalwart serves this from 1.0.0.

An object has two sets of namespaces. `metadata` is read by everyone the object is shared with;
the templates (`template.<id>`, `templates`) and shared tags are there. `privateMetadata` is read
and written only by the signed-in user: someone who has the Inbox shared with them (a delegate) gets
an empty one. Settings are the user's own (sidebar links, how they read and write mail), so they are
in the private set. This was tested on Stalwart 1.1.0 only. An account must advertise `supportsPrivate` for Mailbox, or nothing is synced.

What a server allows, measured on Stalwart 1.1.0 with its default configuration:

| Limit | Value |
|---|---|
| One namespace | 8192 bytes of JSON; the value must be an object |
| All private namespaces of the Inbox together | 16384 bytes (the shared ones have 65536 of their own) |
| Namespaces on the Inbox | 128 |
| `privateMetadata/<namespace>/<member>` in a `Mailbox/set` update | sets one member; refused (`invalidPatch`) when the namespace does not exist |

A metadata change moves the Mailbox state and is pushed as a `Mailbox` state change;
`Mailbox/changes` reports it with `updatedProperties: ["privateMetadata"]`.

## Entries

A setting is stored under its **webmail name** (`firstDayOfWeek`, not the app's
`calendarFirstDayOfWeek`; the app's map is `SETTINGS_KEY_MAP`). Names are letters and digits,
starting with a letter, at most 64 characters.

**Plain values** (boolean, number, string, null) are members of one of eight shard entries:

```
org.bulwarkmail.settings.shard.<0-7>
{ "showPreview": { "v": false, "at": 1794571200000 },
  "density":     { "at": 1794571260000 } }
```

The shard is the FNV-1a hash (32 bit, over the UTF-16 code units of the name) modulo 8, so every
client finds a setting without a table, including one it has never heard of.

**Lists and maps** have an entry each, named after the setting in kebab case:

```
org.bulwarkmail.settings.value.attachment-reminder-keywords
{ "k": "attachmentReminderKeywords", "v": ["attached", "invoice"], "at": 1794571200000 }
```

`k` is the name; the namespace is only derived from it. One long list then cannot crowd other
settings out of a shard. Whether a setting is a list or a map goes by its default value.

In both:

- `at` is when the setting was last changed, in milliseconds since the epoch, on the clock of the
  device that changed it.
- `v` is the value. An entry **without `v`** means the setting was put back to its default at `at`
  and is no longer the user's choice.
- An entry with `v` is the user's choice (the webmail's `explicitSettings`): values nobody chose are
  not stored, so an organisation default can still apply to them.

A reader that finds a setting in both places takes the one with the newer `at`. Members and entries
a client does not know are left alone.

## Merging

For each setting, the newer `at` wins. A list or a map is one setting: it is replaced whole, not
merged item by item.

- **Account newer:** take the value (or the reset), and remember its `at`.
- **Device newer:** write the value with its `at`.
- **Account has none, device has a stamp:** write it. This also repairs a write lost to another
  device that created the same shard at the same moment.
- **Account has none, device has a chosen value without a stamp** (chosen before the device ever
  synced, or while sync was switched off): write it with `at: 1`, a value of unknown age that any
  later change beats.
- **Account has a value, device has a different chosen value without a stamp:** take the account's,
  and offer the user the device's value back ("Use this device's"), which then counts as a change
  made now.
- A device value that is not the user's choice (the default after a reset, or a setting an imported
  file names without it ever having been chosen on the device) is written without `v`.
- **Same `at`, different value:** take the account's. Two devices that fill the same gap at once
  then agree on whichever write landed last.
- A value the device cannot use (an option a newer client added) is neither taken nor written over.
- A setting the organisation policy pins is neither taken nor sent.
- A change made on a device is stamped `max(now, previous stamp + 1)`, so it beats the value it
  replaces even if that came from a device whose clock runs ahead.

Writes: one `Mailbox/set` update carries all plain settings of a round, as members of the shards
that exist and as whole entries for shards that do not yet. Each list or map goes in an update of
its own, so one that the server refuses for its size stops only itself; it stays on the device and
is offered again once it changes. When the plain settings themselves are refused (the 16 KB are
used up), the page says the account has no room, and they are sent again in a later round.

## What syncs

The settings a settings export carries, except:

- the device ones in `DEVICE_LOCAL_KEYS` (swipe mode, reading pane, offline mail, Files view, whether
  and where settings sync);
- the ones in `UNSYNCED_SETTING_KEYS`: notification switches and mutes (they depend on the device's
  permission and push registration), the maps keyed by the JMAP ids of the accounts on the device
  (preferred sender identities, shared calendar colours), trusted senders (they grow with every
  reply and would need merging sender by sender; "Sync trusted senders with contacts" shares them
  already), the message list order (its direction is a device setting, and a change has to re-read
  the lists), and debug logging;
- the `explicitSettings` list, which the entries express themselves.

## Which account, and when

One account holds the settings of the whole app: the first one signed in, or the one picked under
Settings > Storage & backup > Settings sync. The same page has the switch (on by default). "First"
is the first in the account list at the first round that reaches its server. Once an account holds
them it stays the holder on that device. When it signs out, sync stops and the page
asks which account to use; nothing is moved to another mailbox unasked. Signed in again it is the
holder again, also when the app gives it another id than before (an id from before ports were part
of it is not given twice): it is known by its login and server. The stamps a device keeps are
for one holder: after a change of holder it meets the new account's copy as a device that never
synced. Two devices sync with each other only if they use the same holder; the page names it.

The requests go through a JMAP client of their own, never the one that follows the active account.

A round runs when the app starts, returns to the foreground or comes back online, 1.5 s after a
change on the device, and when the account's mailboxes change on the server (at most every 30 s,
since new mail changes them too; only the active account's changes are pushed to the app). A round
waits for the organisation policy of the active account, so that pinned settings are known. After
a failed round the next try is ten minutes later, or sooner on any of the above or "Sync now".

While sync is switched off, changes are not stamped, and a setting changed meanwhile loses the stamp
it had. Switched on again, the device meets the account, for those settings, as one that never
synced (see Merging); the others keep their stamps.

On a server without Metadata nothing is asked and the section is hidden.

## Not done

- The webmail still syncs through its own `/api/settings`; until it reads these entries, the app
  syncs with other installs of the app only.
- A list longer than 8 KB, or one the 16 KB have no room for, stays on the device, as does a text
  longer than 1 KB among the plain settings. They are offered again once they change.
- The offer to take a replaced value back is all that protects the choices of a device that syncs
  second after an upgrade; it is kept until taken or closed.
- The app's switch does not follow the webmail's `settingsSyncEnabled` server option: the app has no
  way to read it for an account signed in without a webmail.
- Stamps are device clocks. A device whose clock is behind loses to a change it has not yet read.
- Each write moves the Mailbox state, so the writing device reads once more within 30 s.
