# Style & Component Transfer Guide

> How Bulwark Webmail's design system is translated into the React Native mobile app.

---

## Architecture Overview

The webmail uses **Next.js + Tailwind CSS** with CSS custom properties (`--color-*`). The mobile app uses **Expo + React Native StyleSheet** with a shared token file that mirrors those CSS variables as JavaScript constants.

```
Webmail (Tailwind CSS)                 Mobile (React Native)
─────────────────────                  ─────────────────────
globals.css / CSS variables    →→→     src/theme/tokens.ts
components/ui/*.tsx            →→→     src/components/*.tsx
Tailwind utility classes       →→→     StyleSheet.create({})
```

The transfer follows a strict pattern: every Tailwind class used in the webmail has a deterministic React Native equivalent defined through the token file, and every shared UI component in the mobile app is a 1:1 port of a webmail component.

---

## Token System (`src/theme/tokens.ts`)

The token file is the single source of truth. It exports five objects that map directly to the webmail's Qui Dark theme.

### Colors

| Token                      | Value     | Webmail CSS Variable         |
| -------------------------- | --------- | ---------------------------- |
| `colors.background`        | `#09090b` | `--color-background`         |
| `colors.text`              | `#fafafa` | `--color-foreground`         |
| `colors.primary`           | `#3b82f6` | `--color-primary`            |
| `colors.primaryForeground` | `#ffffff` | `--color-primary-foreground` |
| `colors.card`              | `#141414` | `--color-card`               |
| `colors.cardForeground`    | `#fafafa` | `--color-card-foreground`    |
| `colors.border`            | `#27272a` | `--color-border`             |
| `colors.muted`             | `#18181b` | `--color-muted`              |
| `colors.mutedForeground`   | `#a1a1aa` | `--color-muted-foreground`   |
| `colors.accent`            | `#27272a` | `--color-accent`             |
| `colors.error`             | `#ef4444` | `--color-destructive`        |
| `colors.warning`           | `#ca8a04` | `--color-warning`            |
| `colors.success`           | `#22c55e` | `--color-success`            |

Additional semantic aliases exist (`textMuted`, `textSecondary`, `surface`, `surfaceHover`, etc.) that map to the same underlying palette for convenience.

### Spacing (Tailwind rem → px)

| Token          | Value | Tailwind Equivalent |
| -------------- | ----- | ------------------- |
| `spacing.xs`   | `4`   | `p-1` (0.25rem)     |
| `spacing.sm`   | `8`   | `p-2` (0.5rem)      |
| `spacing.md`   | `12`  | `p-3` (0.75rem)     |
| `spacing.lg`   | `16`  | `p-4` (1rem)        |
| `spacing.xl`   | `20`  | `p-5` (1.25rem)     |
| `spacing.xxl`  | `24`  | `p-6` (1.5rem)      |
| `spacing.xxxl` | `32`  | `p-8` (2rem)        |

**Conversion rule:** `Tailwind rem × 16 = RN pixels`. Hard-coded pixel values (e.g., `py-3.5` = 14px) are written inline where no token exists.

### Border Radius

| Token         | Value  | Tailwind       |
| ------------- | ------ | -------------- |
| `radius.sm`   | `6`    | `rounded-md`   |
| `radius.md`   | `8`    | `rounded-lg`   |
| `radius.lg`   | `12`   | `rounded-xl`   |
| `radius.full` | `9999` | `rounded-full` |

### Typography

| Token                   | fontSize | fontWeight | Tailwind                  |
| ----------------------- | -------- | ---------- | ------------------------- |
| `typography.h1`         | 24       | 700        | `text-2xl font-bold`      |
| `typography.h2`         | 20       | 600        | `text-xl font-semibold`   |
| `typography.h3`         | 18       | 600        | `text-lg font-semibold`   |
| `typography.body`       | 14       | 400        | `text-sm`                 |
| `typography.bodyMedium` | 14       | 500        | `text-sm font-medium`     |
| `typography.caption`    | 12       | 400        | `text-xs`                 |
| `typography.small`      | 10       | 500        | `text-[10px] font-medium` |

### Component Sizes

| Token                         | Value | Webmail Origin |
| ----------------------------- | ----- | -------------- |
| `componentSizes.headerHeight` | `56`  | `h-14`         |
| `componentSizes.inputHeight`  | `40`  | `h-10`         |
| `componentSizes.buttonMd`     | `40`  | `h-10`         |
| `componentSizes.buttonSm`     | `36`  | `h-9`          |
| `componentSizes.buttonLg`     | `44`  | `h-11`         |
| `componentSizes.toggleWidth`  | `44`  | `w-11`         |
| `componentSizes.toggleHeight` | `24`  | `h-6`          |
| `componentSizes.toggleThumb`  | `16`  | `h-4 w-4`      |
| `componentSizes.avatarMd`     | `40`  | `w-10 h-10`    |

---

## Component Transfer Map

Each mobile component in `src/components/` is a direct port of a webmail component. The table below shows the mapping.

| Mobile Component | Webmail Source                                                      | Key File                          |
| ---------------- | ------------------------------------------------------------------- | --------------------------------- |
| `Button`         | `components/ui/button.tsx`                                          | `src/components/Button.tsx`       |
| `Input`          | `components/ui/input.tsx`                                           | `src/components/Input.tsx`        |
| `Badge`          | `components/ui/badge.tsx`                                           | `src/components/Badge.tsx`        |
| `Card`           | `components/ui/card.tsx`                                            | `src/components/Card.tsx`         |
| `ToggleSwitch`   | `components/settings/settings-section.tsx` (ToggleSwitch)           | `src/components/ToggleSwitch.tsx` |
| `RadioGroup`     | `components/settings/settings-section.tsx` (RadioGroup)             | `src/components/RadioGroup.tsx`   |
| `Dialog`         | `components/ui/confirm-dialog.tsx`                                  | `src/components/Dialog.tsx`       |
| `SettingItemRow` | `components/settings/settings-section.tsx` (SettingItem)            | `src/components/Card.tsx`         |
| `SectionHeader`  | `components/settings/settings-section.tsx` (SettingsSection header) | `src/components/Card.tsx`         |

All components are barrel-exported from `src/components/index.ts`.

---

## Translating Tailwind to React Native StyleSheet

This section documents the exact translation patterns used throughout the codebase.

### Layout

| Tailwind                            | React Native                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `flex items-center justify-between` | `flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'` |
| `flex-col`                          | `flexDirection: 'column'` (default)                                           |
| `flex-1`                            | `flex: 1`                                                                     |
| `gap-3`                             | `gap: 12` (3 × 4px)                                                           |
| `w-full`                            | `width: '100%'` or parent flex                                                |
| `self-start`                        | `alignSelf: 'flex-start'`                                                     |

### Spacing

| Tailwind                       | React Native                                      |
| ------------------------------ | ------------------------------------------------- |
| `px-5`                         | `paddingHorizontal: 20`                           |
| `py-3.5`                       | `paddingVertical: 14`                             |
| `mx-5 my-2`                    | `marginHorizontal: 20, marginVertical: 8`         |
| `p-4`                          | `padding: spacing.lg` (16)                        |
| `mt-1`                         | `marginTop: 4`                                    |
| `space-y-4` (between children) | `gap: 16` on parent or `marginBottom` on children |

### Borders

| Tailwind                 | React Native                                             |
| ------------------------ | -------------------------------------------------------- |
| `border border-input`    | `borderWidth: 1, borderColor: colors.border`             |
| `border-b border-border` | `borderBottomWidth: 1, borderBottomColor: colors.border` |
| `border-t`               | `borderTopWidth: 1, borderTopColor: colors.border`       |
| `rounded-md`             | `borderRadius: radius.sm` (6)                            |
| `rounded-lg`             | `borderRadius: radius.md` (8)                            |
| `rounded-full`           | `borderRadius: radius.full` (9999)                       |

### Colors & Opacity

| Tailwind                | React Native                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `bg-background`         | `backgroundColor: colors.background`                             |
| `text-foreground`       | `color: colors.text`                                             |
| `text-muted-foreground` | `color: colors.mutedForeground`                                  |
| `text-destructive`      | `color: colors.error`                                            |
| `bg-warning/15`         | `backgroundColor: 'rgba(202, 138, 4, 0.15)'`                     |
| `hover:bg-muted`        | `pressed && { backgroundColor: colors.muted }` (via `Pressable`) |
| `disabled:opacity-50`   | `opacity: 0.5` applied conditionally                             |

### Typography

| Tailwind                                         | React Native                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `text-sm`                                        | `...typography.body` (fontSize: 14)                                               |
| `text-sm font-medium`                            | `...typography.bodyMedium`                                                        |
| `text-xs font-semibold uppercase tracking-wider` | `fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8` |
| `text-lg font-semibold`                          | `...typography.h3`                                                                |
| `text-[10px] font-medium`                        | `...typography.small`                                                             |

### Shadows

| Tailwind           | React Native                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `shadow-sm`        | `shadowColor: '#000', shadowOffset: {width:0,height:1}, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1` |
| `shadow-xl`        | Higher `shadowOpacity` and `elevation` values                                                               |
| `ring-2 ring-ring` | `borderColor: colors.borderFocus, shadowColor: colors.borderFocus, shadowOpacity: 0.25`                     |

---

## Interaction State Translation

Web CSS has `:hover`, `:focus`, `:active` pseudo-classes. React Native uses `Pressable` with style functions.

```tsx
// Webmail (Tailwind)
<button className="hover:bg-accent active:bg-accent/80">

// Mobile (React Native)
<Pressable
  style={({ pressed }) => [
    styles.button,
    pressed && styles.buttonPressed,   // pressed = hover + active combined
  ]}
>
```

Focus rings on inputs are translated to `borderColor` + `shadow` changes on the `onFocus` / `onBlur` events of `TextInput`.

---

## Screen-Level Patterns

### Header Bar

Every screen uses the same header pattern matching the webmail's mobile header:

```tsx
// Webmail: <div className="h-14 px-4 border-b border-border flex items-center gap-2">
<View style={{
  flexDirection: 'row',
  alignItems: 'center',
  height: componentSizes.headerHeight,  // 56px = h-14
  paddingHorizontal: spacing.lg,        // 16px = px-4
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  gap: spacing.sm,                      // 8px = gap-2
}}>
```

### Settings Screen (Flat Navigation List)

The settings screen (`SettingsScreenNew2.tsx`) matches the webmail's mobile settings layout exactly:

| Webmail Pattern                                                                      | Mobile Implementation                                                                                            |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Groups separated by `border-t border-border`                                         | 1px `View` with `backgroundColor: colors.border`                                                                 |
| Group header: `text-xs font-semibold uppercase tracking-wider text-muted-foreground` | `fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: colors.mutedForeground` |
| Tab item: `px-5 py-3.5 text-sm` with icon + label + `ChevronRight`                   | `paddingHorizontal: 20, paddingVertical: 14` with 16px monochrome icon, label, and `ChevronRight`                |
| `hover:bg-muted` on items                                                            | `pressed && { backgroundColor: colors.muted }`                                                                   |
| Logout: `text-destructive` with `LogOut` icon, `border-t`                            | `color: colors.error`, `borderTopWidth: 1` separator                                                             |

Tab categories match the webmail 1:1: **General** (Appearance, Email, Notifications), **Account**, **Organization**, **Apps**, **System**.

### Email List

Uses a `FlatList` with row items that match the webmail's email list rows:

- Avatar with colored background from a fixed palette
- Sender name bolded when unread (`fontWeight: '600'`)
- Tag pills using `colors.tags.*` (bg + dot + text triplets)
- Starred indicator: `Star` icon filled with `colors.starred`
- FAB compose button: `Button` component with `variant="default" size="icon"`

### Compose Screen

Mirrors the webmail composer:

- Field rows with bottom borders matching `border-b border-border`
- Recipient chips: `backgroundColor: colors.primaryBg`, `borderRadius: radius.full`
- Send button: `Button variant="default" size="sm"` with `Send` icon
- Quote block: left border accent using `colors.border`

---

## Adding a New Component

To port a new webmail component to the mobile app:

1. **Read the webmail component** — identify Tailwind classes and CSS variables used.
2. **Map tokens** — find the corresponding value in `tokens.ts`. If a color or spacing doesn't exist, add it to the token file first.
3. **Create the RN component** in `src/components/` — match the prop interface (variant names, size names, etc.).
4. **Translate each Tailwind class** using the patterns documented above.
5. **Replace hover/focus states** with `Pressable` `pressed` and `TextInput` `onFocus`/`onBlur`.
6. **Export from `index.ts`** — add the barrel export.
7. **Match accessibility** — use `accessibilityRole`, `accessibilityState`, and `accessibilityLabel` where the webmail uses ARIA attributes.

### Checklist

- [ ] Token values match the webmail CSS variables
- [ ] Variant and size names are identical to the webmail component
- [ ] Pressed/focus states exist for all interactive elements
- [ ] Border radius uses token values, not hardcoded numbers
- [ ] Typography uses spread syntax (`...typography.body`) not manual fontSize/fontWeight
- [ ] Colors reference `colors.*` tokens, never hex literals (except for opacity variants like `rgba()`)

---

## File Structure

```
repos/react-native/
├── src/
│   ├── theme/
│   │   └── tokens.ts              # All design tokens (colors, spacing, radius, typography, sizes)
│   ├── components/
│   │   ├── index.ts               # Barrel exports
│   │   ├── Button.tsx             # ← components/ui/button.tsx
│   │   ├── Input.tsx              # ← components/ui/input.tsx
│   │   ├── Badge.tsx              # ← components/ui/badge.tsx
│   │   ├── Card.tsx               # ← components/ui/card.tsx + settings-section.tsx
│   │   ├── ToggleSwitch.tsx       # ← settings-section.tsx ToggleSwitch
│   │   ├── RadioGroup.tsx         # ← settings-section.tsx RadioGroup
│   │   └── Dialog.tsx             # ← components/ui/confirm-dialog.tsx
│   └── screens/
│       ├── SettingsScreenNew2.tsx  # ← app/[locale]/settings/page.tsx (mobile layout)
│       ├── LoginScreen.tsx        # Uses Input, Button
│       ├── EmailListScreen.tsx    # Uses Button (FAB)
│       ├── ComposeScreen.tsx      # Uses Button (Send)
│       ├── CalendarScreenNew.tsx  # Uses Button (add/today)
│       ├── ContactsScreenNew.tsx  # Uses Button (add)
│       └── EmailThreadScreen.tsx  # Uses Button (Reply/Forward)
└── App.tsx                        # Tab navigator, theme colors on tab bar
```
