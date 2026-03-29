# Bulwark Mobile — React Native Port Plan

## Architecture Overview

```
repos/react-native/
├── src/
│   ├── lib/              ← COPIED from web (pure logic, protocol clients)
│   ├── stores/           ← COPIED from web (Zustand stores, adapted persistence)
│   ├── screens/          ← NEW (React Navigation screens)
│   ├── components/       ← NEW (React Native UI components)
│   ├── hooks/            ← MIXED (some copied, some new for gestures/nav)
│   ├── navigation/       ← NEW (React Navigation config)
│   ├── theme/            ← NEW (RN styling system replacing CSS/Tailwind)
│   └── platform/         ← NEW (platform adapters: storage, notifications, crypto)
├── app.json
├── package.json
└── tsconfig.json
```

## Shared Code Strategy

The web codebase at `lib/`, `stores/` contains ~86 files of reusable logic.
Rather than copy-paste, create a **shared package** approach:

### Option A: Monorepo with shared package (recommended)

```
jmap-webmail/
├── packages/
│   ├── shared/           ← extracted from lib/ and stores/
│   │   ├── jmap/
│   │   ├── webdav/
│   │   ├── sieve/
│   │   ├── oauth/
│   │   ├── smime/
│   │   ├── stores/
│   │   └── utils/
│   ├── web/              ← current Next.js app (imports from shared)
│   └── mobile/           ← React Native app (imports from shared)
```

### Option B: Copy and maintain separately (simpler to start)

Copy reusable files into `repos/react-native/src/lib/` and adapt.
Easier to start but diverges over time.

**Recommendation**: Start with Option B to validate the RN app, migrate to Option A later.

---

## Phase 0: Project Setup

### Tasks

- [ ] Initialize Expo project (SDK 53+, managed workflow)
- [ ] Configure TypeScript
- [ ] Install core dependencies (see below)
- [ ] Set up NativeWind (Tailwind CSS for RN) to maximize style reuse
- [ ] Configure React Navigation (native stack + bottom tabs)
- [ ] Create platform adapter layer (storage, crypto, notifications)

### Dependencies

```json
{
  "dependencies": {
    "expo": "~53.0.0",
    "react": "19.x",
    "react-native": "0.79.x",

    "zustand": "^5.0.9",
    "date-fns": "^4.1.0",
    "clsx": "^2.1.1",

    "@react-navigation/native": "^7.x",
    "@react-navigation/native-stack": "^7.x",
    "@react-navigation/bottom-tabs": "^7.x",

    "nativewind": "^4.x",
    "tailwind-merge": "^3.4.0",

    "expo-secure-store": "~14.x",
    "@react-native-async-storage/async-storage": "^2.x",
    "expo-notifications": "~0.29.x",
    "expo-av": "~15.x",
    "expo-file-system": "~18.x",
    "expo-web-browser": "~14.x",
    "expo-linking": "~7.x",

    "react-native-webview": "^14.x",
    "react-native-gesture-handler": "~2.x",
    "react-native-reanimated": "~3.x",

    "lucide-react-native": "^0.575.0",

    "postal-mime": "^2.7.4",
    "jszip": "^3.10.1"
  }
}
```

### Platform Adapter Layer

Create `src/platform/` to abstract browser vs native differences:

```typescript
// src/platform/storage.ts
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const storage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};
```

```typescript
// src/platform/notifications.ts
import * as Notifications from "expo-notifications";

export async function scheduleLocalNotification(title: string, body: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: null, // immediate
  });
}
```

```typescript
// src/platform/auth.ts
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";

export async function openOAuthFlow(authUrl: string): Promise<string> {
  const redirectUrl = Linking.createURL("auth/callback");
  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
  if (result.type === "success") return result.url;
  throw new Error("Auth cancelled");
}
```

---

## Phase 1: Core Logic Port (copy + adapt)

### 1.1 Pure Utilities — Direct Copy

These files have ZERO browser dependencies. Copy as-is:

```
lib/account-utils.ts
lib/calendar-alerts.ts
lib/calendar-event-normalization.ts
lib/calendar-invitation.ts
lib/calendar-participants.ts
lib/calendar-utils.ts
lib/color-transform.ts
lib/email-headers.ts
lib/file-preview.ts
lib/recurrence-expansion.ts
lib/reply-identity.ts
lib/signature-utils.ts
lib/sub-addressing.ts
lib/template-types.ts
lib/template-utils.ts
lib/thread-utils.ts
lib/tnef.ts
lib/utils.ts             ← remove tailwind-merge (clsx) usage or keep with NativeWind
lib/validation.ts
lib/vcard.ts
```

### 1.2 Protocol Clients — Direct Copy

These use `fetch()` which works in React Native:

```
lib/jmap/client.ts
lib/jmap/client-interface.ts
lib/jmap/types.ts
lib/jmap/search-utils.ts
lib/jmap/sieve-types.ts
lib/webdav/client.ts
lib/sieve/parser.ts
lib/sieve/generator.ts
lib/oauth/discovery.ts
lib/oauth/pkce.ts
lib/oauth/token-exchange.ts
lib/oauth/tokens.ts       ← swap cookie storage → SecureStore
lib/stalwart/client.ts
lib/stalwart/credentials.ts
lib/admin/config-manager.ts
lib/admin/audit.ts
lib/admin/session.ts
lib/admin/types.ts
lib/demo/demo-client.ts
lib/demo/demo-data.ts
lib/demo/demo-utils.ts
```

### 1.3 Stores — Copy + Adapt Persistence

All Zustand stores work in RN. Only change: replace `persist` middleware's
default `localStorage` with AsyncStorage.

Create a shared persist config:

```typescript
// src/platform/zustand-storage.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJSONStorage } from "zustand/middleware";

export const asyncStorageAdapter = createJSONStorage(() => ({
  getItem: async (name: string) => await AsyncStorage.getItem(name),
  setItem: async (name: string, value: string) =>
    await AsyncStorage.setItem(name, value),
  removeItem: async (name: string) => await AsyncStorage.removeItem(name),
}));
```

Then in each store that uses `persist`:

```typescript
// Before (web):
persist(storeInit, {
  name: "settings",
  storage: createJSONStorage(() => localStorage),
});

// After (RN):
persist(storeInit, { name: "settings", storage: asyncStorageAdapter });
```

Stores to adapt:

- `auth-store.ts` — use SecureStore for tokens instead of AsyncStorage
- `smime-store.ts` — use SecureStore for private keys
- `settings-store.ts`, `locale-store.ts`, `template-store.ts`, `plugin-store.ts`,
  `calendar-store.ts`, `theme-store.ts` — use AsyncStorage adapter
- `ui-store.ts` — replace `window.innerWidth` with `Dimensions.get('window')`

### 1.4 Adapt Browser-Specific Libs

| File                    | Adaptation                                                                |
| ----------------------- | ------------------------------------------------------------------------- |
| `email-sanitization.ts` | Don't sanitize for RN — render HTML emails inside `<WebView>`             |
| `notification-sound.ts` | Replace `AudioContext` → `expo-av` Audio.Sound                            |
| `settings-sync.ts`      | Replace `localStorage` cache → AsyncStorage                               |
| `browser-navigation.ts` | Delete — use React Navigation instead                                     |
| `iframe-bridge.ts`      | Delete — not applicable                                                   |
| `theme-loader.ts`       | Delete — use NativeWind/StyleSheet                                        |
| `plugin-loader.ts`      | Defer — plugins are a stretch goal                                        |
| `error-reporting.ts`    | Replace `navigator`/`window` → `Platform.OS`, `Application.nativeVersion` |

---

## Phase 2: Navigation & Infrastructure

### 2.1 Navigation Structure

```typescript
// src/navigation/index.tsx
const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Email" component={EmailStack} />
      <Tab.Screen name="Calendar" component={CalendarStack} />
      <Tab.Screen name="Contacts" component={ContactsStack} />
      <Tab.Screen name="Files" component={FilesStack} />
      <Tab.Screen name="Settings" component={SettingsStack} />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Main" component={MainTabs} />
    </Stack.Navigator>
  );
}
```

### Screen Mapping (web route → RN screen)

| Web Route         | RN Screen                    | Stack              |
| ----------------- | ---------------------------- | ------------------ |
| `/login`          | `LoginScreen`                | Root               |
| `/` (inbox)       | `EmailListScreen`            | EmailStack         |
| email thread view | `EmailThreadScreen`          | EmailStack         |
| email composer    | `ComposeScreen`              | EmailStack (modal) |
| `/calendar`       | `CalendarScreen`             | CalendarStack      |
| `/calendar/[id]`  | `EventDetailScreen`          | CalendarStack      |
| `/contacts`       | `ContactListScreen`          | ContactsStack      |
| `/contacts/[id]`  | `ContactDetailScreen`        | ContactsStack      |
| `/contacts/new`   | `ContactFormScreen`          | ContactsStack      |
| `/files`          | `FileBrowserScreen`          | FilesStack         |
| `/settings/*`     | `Settings*Screen` (multiple) | SettingsStack      |

### 2.2 Hooks — Adapt or Replace

**Keep (works in RN):**

- `use-calendar-alerts.ts` — wire to `expo-notifications`
- `use-config.ts` — pure state
- `use-sidebar-apps.ts` — pure state

**Rewrite:**

- `use-confirm-dialog.ts` → RN Alert.alert() or custom modal
- `use-context-menu.ts` → RN action sheet or custom bottom sheet
- `use-media-query.ts` → `useWindowDimensions()` from react-native
- `use-long-press.ts` → `Pressable` with `onLongPress` or gesture handler
- `use-email-drag.ts` → gesture handler PanGesture (or skip for v1)
- `use-mailbox-drop.ts` → gesture handler (or skip for v1)
- `use-tag-drop.ts` → gesture handler (or skip for v1)
- `use-keyboard-shortcuts.ts` → not applicable on mobile (skip)
- `use-focus-trap.ts` → not applicable on mobile (skip)
- `use-time-grid-interactions.ts` → gesture handler for calendar

### 2.3 Internationalization

Replace `next-intl` with `expo-localization` + `i18next`:

- Reuse all translation JSON files from `locales/` directly
- Only change the i18n provider setup

---

## Phase 3: UI Components — Build Order

Build from the bottom up: primitives → composites → screens.

### 3.1 UI Primitives (`src/components/ui/`)

Build equivalents of your web `components/ui/`:

| Web Component      | RN Equivalent                 | Notes                           |
| ------------------ | ----------------------------- | ------------------------------- |
| `button.tsx`       | `<Pressable>` + styles        | NativeWind for Tailwind classes |
| `input.tsx`        | `<TextInput>`                 |                                 |
| `context-menu.tsx` | Action sheet / bottom sheet   | `@gorhom/bottom-sheet`          |
| `toast.tsx`        | Toast notification            | `react-native-toast-message`    |
| `avatar.tsx`       | `<Image>` + fallback `<View>` |                                 |
| Modal system       | `<Modal>` from RN             |                                 |
| Dropdown/Select    | Bottom sheet picker           |                                 |
| Checkbox/Switch    | `<Switch>` from RN            |                                 |

### 3.2 Email Components (highest priority)

Build order:

1. **MailboxList** — sidebar/drawer showing folders (Inbox, Sent, Drafts, etc.)
2. **EmailList** — virtualized list (`FlashList`) of email summaries
3. **EmailViewer** — render email body in `<WebView>` with HTML sanitization
4. **EmailComposer** — rich text input (hardest part — see note below)
5. **ThreadView** — conversation thread rendering
6. **AttachmentViewer** — file type preview + download
7. **SearchBar** — email search with filter chips

#### Rich Text Editor Note

TipTap does NOT work in React Native. Options:

- **`react-native-pell-rich-editor`** — basic HTML editor
- **`@10play/tentap-editor`** — TipTap port for RN (best option, maintains some API compatibility)
- **WebView-based editor** — load TipTap in a WebView (functional but slower)

Recommendation: Use **`@10play/tentap-editor`** for closest parity with your TipTap setup.

### 3.3 Calendar Components

Build order:

1. **MonthView** — grid of days with event dots
2. **WeekView** — 7-column time grid with event blocks
3. **DayView** — single-column time grid
4. **AgendaView** — flat list of upcoming events (mobile-friendly)
5. **EventDetail** — event info + RSVP
6. **EventForm** — create/edit event modal
7. **MiniCalendar** — compact date picker

Consider using `react-native-calendars` as a base for month view.

### 3.4 Contacts Components

Build order:

1. **ContactList** — alphabetical sections list (`SectionList`)
2. **ContactDetail** — vCard fields display
3. **ContactForm** — create/edit with field types
4. **ContactImport** — vCard file import

### 3.5 Files Components

Build order:

1. **FileBrowser** — folder tree + file list
2. **FilePreview** — image/PDF preview
3. **FileUpload** — `expo-document-picker` + upload progress

### 3.6 Settings Components

Build order:

1. **SettingsMenu** — grouped list of settings categories
2. **AccountSettings** — account info, password change
3. **AppearanceSettings** — theme picker, font size, density
4. **EmailSettings** — signatures, identity management
5. **CalendarSettings** — default calendar, week start
6. **NotificationSettings** — push notification preferences
7. **PrivacySettings** — S/MIME, trusted senders

### 3.7 Layout Components

- **AppShell** — tab bar + optional drawer
- **Header** — screen title + actions
- **SearchHeader** — collapsible search bar

---

## Phase 4: Platform Features

### 4.1 Push Notifications

- Use `expo-notifications` for local calendar alerts
- Use push notification service for new email alerts (requires server-side push endpoint)

### 4.2 OAuth Flow

- Use `expo-web-browser` AuthSession for OAuth/OIDC login
- Deep link callback: `bulwarkmail://auth/callback`
- Store tokens in `expo-secure-store`

### 4.3 Offline Support

- Zustand `persist` with AsyncStorage gives basic offline state
- For full offline: cache emails/contacts in SQLite (`expo-sqlite`)

### 4.4 File Handling

- `expo-document-picker` for attachment selection
- `expo-file-system` for download/cache
- `expo-sharing` for share sheet integration

### 4.5 Biometric Auth

- `expo-local-authentication` for fingerprint/face unlock

---

## Phase 5: Polish & Ship

- [ ] App icons and splash screen
- [ ] Dark mode (leverage existing theme store logic)
- [ ] Haptic feedback (`expo-haptics`)
- [ ] App Store / Play Store submission
- [ ] Desktop via Expo for web or React Native Windows/macOS

---

## What to Skip for v1

These features from the web app can be deferred:

- **Admin panel** — keep web-only for now
- **Plugin system** — complex, defer
- **Drag and drop** (email to mailbox) — use swipe actions instead
- **Keyboard shortcuts** — not applicable on mobile
- **S/MIME** — complex crypto, defer to v2
- **Sieve filter editor** — use simplified UI or defer
- **Custom themes/CSS** — use built-in light/dark
- **Tour/onboarding overlay** — defer
- **File browser** — defer if not core

---

## v1 MVP Scope

The minimum viable mobile app:

1. **Login** (OAuth + basic auth)
2. **Email** (list, read, compose, reply, forward, search, attachments)
3. **Calendar** (month/day/agenda view, create/edit events, RSVP)
4. **Contacts** (list, view, create/edit, search)
5. **Settings** (account, appearance, notifications)
6. **Push notifications** (new email, calendar alerts)

This gives users a functional mobile email+calendar+contacts app
while deferring advanced features to v2.

---

## File Reuse Summary

| Category                                            | Files    | Reusable | Action                    |
| --------------------------------------------------- | -------- | -------- | ------------------------- |
| Pure utils (`lib/*.ts`)                             | 19       | 100%     | Copy                      |
| Protocol clients (`lib/jmap/`, `webdav/`, `sieve/`) | 10       | 100%     | Copy                      |
| OAuth/Auth (`lib/oauth/`, `auth/`)                  | 7        | 70-80%   | Copy + adapt storage      |
| Demo data (`lib/demo/`)                             | 3        | 100%     | Copy                      |
| Admin API (`lib/admin/`)                            | 7        | 90%      | Copy                      |
| Stalwart client (`lib/stalwart/`)                   | 2        | 90%      | Copy                      |
| Zustand stores (`stores/`)                          | 23       | 80%      | Copy + swap persist layer |
| Translation files (`locales/`)                      | all      | 100%     | Copy                      |
| Hooks                                               | 3 of 13  | 23%      | Copy 3, rewrite 10        |
| Components                                          | 0 of 123 | 0%       | Full rewrite              |

**Total reusable**: ~74 files (~38% of codebase by file count, higher by logic value)
