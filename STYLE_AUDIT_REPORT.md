# React Native Style Audit Report

**Generated:** March 29, 2026  
**Scope:** All 5 main screens vs. `tokens.ts` and webmail styling inventory

---

## TOKEN COVERAGE SUMMARY

### Colors Used Across All Screens

| Token                    | EmailThread | Compose | Calendar | Contacts | Settings | Exists in tokens.ts? |
| ------------------------ | :---------: | :-----: | :------: | :------: | :------: | :------------------: |
| `colors.primary`         |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.primaryBg`       |      —      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.primaryLight`    |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.text`            |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.textSecondary`   |     ✅      |   ✅    |    —     |    ✅    |    ✅    |          ✅          |
| `colors.textMuted`       |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.textInverse`     |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.background`      |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.surface`         |     ✅      |    —    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.surfaceHover`    |     ✅      |    —    |    —     |    ✅    |    ✅    |          ✅          |
| `colors.surfaceActive`   |     ✅      |   ✅    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.border`          |     ✅      |   ✅    |    ✅    |    —     |    —     |          ✅          |
| `colors.borderLight`     |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |          ✅          |
| `colors.error`           |     ✅      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.errorBg`         |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.starred`         |     ✅      |    —    |    —     |    —     |    —     |          ✅          |
| `colors.successBg`       |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.warningBg`       |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.calendar.blue`   |      —      |    —    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.calendar.purple` |      —      |    —    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.calendar.green`  |     ✅      |    —    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.calendar.orange` |      —      |    —    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.calendar.red`    |      —      |    —    |    ✅    |    —     |    —     |          ✅          |
| `colors.calendar.pink`   |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.calendar.teal`   |      —      |    —    |    ✅    |    —     |    ✅    |          ✅          |
| `colors.calendar.indigo` |      —      |    —    |    —     |    —     |    ✅    |          ✅          |
| `colors.tags.blue.dot`   |     ✅      |    —    |    —     |    —     |    —     |          ✅          |
| `colors.tags.blue.bg`    |     ✅      |    —    |    —     |    —     |    —     |          ✅          |

### Spacing Tokens Used

| Token          | EmailThread | Compose | Calendar | Contacts | Settings |
| -------------- | :---------: | :-----: | :------: | :------: | :------: |
| `spacing.xs`   |      —      |   ✅    |    ✅    |    ✅    |    ✅    |
| `spacing.sm`   |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `spacing.md`   |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `spacing.lg`   |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `spacing.xl`   |      —      |   ✅    |    ✅    |    —     |    ✅    |
| `spacing.xxl`  |      —      |    —    |    —     |    —     |    —     |
| `spacing.xxxl` |      —      |    —    |    ✅    |    ✅    |    —     |

### Typography Tokens Used

| Token                      | EmailThread | Compose | Calendar | Contacts | Settings |
| -------------------------- | :---------: | :-----: | :------: | :------: | :------: |
| `typography.h2`            |     ✅      |    —    |    —     |    —     |    —     |
| `typography.h3`            |      —      |    —    |    ✅    |    ✅    |    ✅    |
| `typography.body`          |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `typography.bodyMedium`    |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `typography.caption`       |     ✅      |   ✅    |    ✅    |    ✅    |    ✅    |
| `typography.captionMedium` |     ✅      |   ✅    |    ✅    |    —     |    —     |
| `typography.small`         |     ✅      |    —    |    ✅    |    ✅    |    ✅    |
| `typography.h1`            |      —      |    —    |    —     |    —     |    —     |
| `typography.bodySemibold`  |      —      |    —    |    —     |    —     |    —     |
| `typography.bodyBold`      |      —      |    —    |    —     |    —     |    —     |
| `typography.base`          |      —      |    —    |    —     |    —     |    —     |
| `typography.baseMedium`    |      —      |    —    |    —     |    —     |    —     |
| `typography.tabLabel`      |      —      |    —    |    —     |    —     |    —     |

---

## MISSING TOKENS (defined in tokens.ts but never used)

### Never-Used Colors

- `colors.primaryDark` — no screen references it
- `colors.primaryBgHover` — no screen references it
- `colors.primaryForeground` — no screen uses it (screens use `textInverse` instead)
- `colors.card` / `colors.cardForeground` — not referenced
- `colors.textLink` — no screen references it
- `colors.borderFocus` — no screen references it
- `colors.success` / `colors.successForeground` — success color never used (only `successBg`)
- `colors.warning` / `colors.warningForeground` — warning never used (only `warningBg`)
- `colors.infoForeground` — never used
- `colors.unread` / `colors.read` — email list uses hardcoded approaches instead
- `colors.flagged` / `colors.draft` — not used anywhere
- `colors.navActive` / `colors.navInactive` / `colors.navBadge` — not used in screens (likely in navigator)
- `colors.secondary` / `colors.secondaryForeground` — never used in screens
- `colors.muted` / `colors.mutedForeground` — never used (screens use textMuted/textSecondary)
- `colors.accent` / `colors.accentForeground` — never used
- `colors.selection` / `colors.selectionForeground` — never used
- `colors.popover` / `colors.popoverForeground` — never used
- `colors.chart1–5` — never used
- All tag colors except `tags.blue` — never used in screens

### Never-Used Spacing

- `spacing.xxl` (24px) — never referenced in any screen

### Never-Used Typography

- `typography.h1` — no screen uses it
- `typography.bodySemibold` / `typography.bodyBold` — never used
- `typography.base` / `typography.baseMedium` — never used (email body should use `base` for 16px content)
- `typography.tabLabel` — not used in screens (likely in tab bar)

### Never-Used componentSizes

- The entire `componentSizes` object is **never imported or used by any screen**. All screens hardcode sizes.

---

## PER-SCREEN DETAILED AUDIT

---

### 1. EmailThreadScreen.tsx

#### Hardcoded Values (should use tokens)

| Line/Style                      | Current Value           | Should Be                                                                                                         | Priority      |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------- |
| `toolbarBtn` width/height       | `40`                    | `componentSizes.buttonMd` (40)                                                                                    | Low (matches) |
| `messageAvatar` size            | `36, borderRadius: 18`  | `componentSizes.buttonSm` (36)                                                                                    | Low (matches) |
| `messageAvatarText` fontSize    | `15`                    | No token — should be `typography.body.fontSize` (14) or 16                                                        | **Medium**    |
| `attachmentIcon` size           | `36`                    | `componentSizes.buttonSm` (36)                                                                                    | Low (matches) |
| `attachmentIconText` fontSize   | `10`                    | `typography.small.fontSize` (10)                                                                                  | Low (matches) |
| `labelBadge` paddingHorizontal  | `8`                     | `spacing.sm` (8)                                                                                                  | Low (matches) |
| `labelBadge` paddingVertical    | `3`                     | Non-standard — should be `2` or `4` (multiple of 4)                                                               | **Medium**    |
| `labelBadge` gap                | `4`                     | `spacing.xs` (4)                                                                                                  | Low (matches) |
| `quickActionBtn` gap            | `6`                     | Non-standard — should be `spacing.xs` (4) or `spacing.sm` (8)                                                     | Low           |
| `messageCardLast` borderColor   | `colors.primary + '30'` | Inline opacity hack — needs a proper token                                                                        | **Medium**    |
| `toolbarActions` gap            | `2`                     | Non-standard — should be `spacing.xs` (4)                                                                         | Low           |
| `scrollContainer` paddingBottom | `40`                    | Should use `spacing.xxxl + spacing.sm` (40) or define a token                                                     | Low           |
| `subjectText` lineHeight        | `28` override           | Redundant — `typography.h2` already has lineHeight 28                                                             | Low           |
| `messageBodyText` lineHeight    | `22`                    | Webmail body uses lineHeight: 1.6 → at 14px = 22.4, at 16px = 25.6. Should use `typography.base` for email bodies | **High**      |

#### Webmail Discrepancies

| Area                      | RN Current                     | Webmail Pattern                                                                           | Fix                                                                                   |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Email body font size**  | `typography.body` (14px)       | Email content uses `text-sm` (14px) for metadata but body HTML is `14px line-height: 1.6` | OK for thread preview but if rendering full HTML, should use `typography.base` (16px) |
| **Toolbar icon size**     | 22px (back), 20px (actions)    | Web: w-5 h-5 = 20px for all                                                               | **Back arrow should be 20, not 22**                                                   |
| **Toolbar button size**   | 40×40                          | Web: w-8 h-8 = 32px with p-1.5                                                            | **Should be 32×32** — currently oversized                                             |
| **Toolbar padding**       | `spacing.sm` (8px)             | Web: py-3 px-4 = 12px vert, 16px horiz                                                    | **Should be paddingHorizontal: spacing.lg, paddingVertical: spacing.md**              |
| **Attachment section bg** | `colors.surfaceHover`          | Web: bg-muted, border rounded                                                             | Matches dark mode                                                                     |
| **Quick action border**   | `colors.border`                | Web: 1px solid --color-border                                                             | ✅ Matches                                                                            |
| **Subject area padding**  | `paddingTop: spacing.sm` (8px) | Web: p-6 = 24px                                                                           | **Should be `spacing.xxl` (24px)**                                                    |

---

### 2. ComposeScreen.tsx

#### Hardcoded Values

| Line/Style                       | Current Value | Should Be                                                      | Priority        |
| -------------------------------- | ------------- | -------------------------------------------------------------- | --------------- |
| `headerBtn` size                 | `40×40`       | Web: 32×32 (w-8 h-8)                                           | **Medium**      |
| `sendButton` paddingVertical     | `8`           | `spacing.sm` (8) ✅                                            | OK              |
| `sendButton` gap                 | `6`           | Non-standard — should be `spacing.xs` (4)                      | Low             |
| `fieldLabel` width               | `52`          | Hardcoded — should be responsive or a constant                 | Low             |
| `fieldLabel` paddingTop          | `6`           | Non-standard value                                             | Low             |
| `chipText` maxWidth              | `200`         | Hardcoded                                                      | Low             |
| `chip` paddingHorizontal         | `10`          | Non-standard — should be `spacing.sm` (8) or `spacing.md` (12) | Low             |
| `chip` paddingVertical           | `4`           | `spacing.xs` (4) ✅                                            | OK              |
| `recipientInput` minWidth        | `100`         | Hardcoded                                                      | Low             |
| `recipientInput` paddingVertical | `4`           | `spacing.xs` (4) ✅                                            | OK              |
| `bodyInput` minHeight            | `200`         | Matches web min-height: 200px ✅                               | OK              |
| `quoteBorder` width              | `3`           | Web: border-left 2px solid                                     | **Should be 2** |
| `quoteText` lineHeight           | `18`          | No matching token                                              | Low             |
| `formatBtn` size                 | `40×36`       | Web: w-8 h-8 = 32×32                                           | **Medium**      |
| `fieldSeparator` height          | `0`           | Dead code — does nothing                                       | Low (cleanup)   |

#### Webmail Discrepancies

| Area                     | RN Current                    | Webmail Pattern                                   | Fix                                                  |
| ------------------------ | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **Header height**        | Auto (sm padding ≈ 40px)      | Web: p-4 = 16px top/bottom = ~56px with content   | **Use `componentSizes.headerHeight` (56px)**         |
| **Send button height**   | Auto (~32px)                  | Web: h-9 = 36px                                   | **Should be height: `componentSizes.buttonSm` (36)** |
| **Field min-height**     | `44`                          | Touch target ✅ Good for mobile                   | OK                                                   |
| **Format toolbar icons** | 18px                          | Web: w-8 h-8 button with smaller icon             | Icon size OK, button 40×36 → **should be 32×32**     |
| **Quote border width**   | `3px`                         | Web: 2px                                          | **Should be 2px**                                    |
| **Input field border**   | None (no border on inputs)    | Web: 1px solid --color-border, border-radius: 4px | **Missing input field borders**                      |
| **Subject input weight** | `typography.bodyMedium` (500) | Web: font-semibold (600) in some states           | **Should use `bodySemibold` for emphasis**           |

---

### 3. CalendarScreenNew.tsx

#### Hardcoded Values

| Line/Style                      | Current Value             | Should Be                                        | Priority          |
| ------------------------------- | ------------------------- | ------------------------------------------------ | ----------------- |
| `headerSubtitle` marginTop      | `2`                       | Non-standard — should be spacing token           | Low               |
| `viewToggle` padding            | `2`                       | Non-standard                                     | Low               |
| `viewToggleBtn` size            | `32×32`                   | Web: w-8 h-8 = 32 ✅                             | OK                |
| `addButton` size                | `36×36`                   | `componentSizes.buttonSm` (36) ✅                | OK                |
| `todayBtn` paddingVertical      | `6`                       | Non-standard                                     | Low               |
| `weekdayRow` marginBottom       | `4`                       | `spacing.xs` (4) ✅                              | OK                |
| `dayNumber` size                | `34×34, borderRadius: 17` | Non-standard — should be 32 or 36                | **Medium**        |
| `eventDotSmall`                 | `5×5, borderRadius: 3`    | `componentSizes.eventDot` (6) and borderRadius 3 | **Should be 6×6** |
| `eventDotsRow` gap              | `2`                       | Non-standard                                     | Low               |
| `eventDotsRow` height           | `5`                       | Should be `6` to match eventDot                  | Low               |
| `eventColorBar` width           | `4`                       | Web: border-left 3px                             | **Should be 3px** |
| `eventBody` gap                 | `4`                       | `spacing.xs` (4) ✅                              | OK                |
| `allDayBadge` paddingHorizontal | `8`                       | `spacing.sm` (8) ✅                              | OK                |
| `allDayBadge` paddingVertical   | `2`                       | Non-standard                                     | Low               |

#### Webmail Discrepancies

| Area                       | RN Current                                     | Webmail Pattern                                     | Fix                                                                            |
| -------------------------- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Today circle**           | `backgroundColor: colors.primary` (solid fill) | Web: ring 2px solid primary (border only, not fill) | **Should be border style, not fill** — this is a significant visual difference |
| **Selected day**           | `primaryBg + 1.5px border primary`             | Web: bg-selection with primary ring                 | Close enough ✅                                                                |
| **Day cell size**          | 34×34                                          | Web: responsive grid cells, typically 32–40px       | **Use 36 for better touch targets**                                            |
| **Event card border-left** | `width: 4` (eventColorBar)                     | Web: 3px solid event-color                          | **Should be 3px**                                                              |
| **Event dot size**         | 5×5                                            | Web: w-1.5 = 6px                                    | **Should be 6×6 (`componentSizes.eventDot`)**                                  |
| **Empty state icon**       | `colors.surfaceActive`                         | Web: text-muted-foreground                          | **Should be `colors.textMuted`**                                               |
| **Calendar grid lines**    | Not visible                                    | Web: border 1px per day cell                        | Minor — mobile intentionally cleaner                                           |

---

### 4. ContactsScreenNew.tsx

#### Hardcoded Values

| Line/Style                         | Current Value             | Should Be                                                                    | Priority            |
| ---------------------------------- | ------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `headerCount` paddingHorizontal    | `8`                       | `spacing.sm` (8) ✅                                                          | OK                  |
| `headerCount` paddingVertical      | `2`                       | Non-standard                                                                 | Low                 |
| `headerBtn` size                   | `40×40`                   | Web: 32×32                                                                   | **Medium**          |
| `addButton` size                   | `36×36`                   | `componentSizes.buttonSm` (36) ✅                                            | OK                  |
| `searchBar` height                 | `40`                      | `componentSizes.inputHeight` (40) ✅                                         | OK                  |
| `contactAvatar` size               | `44×44, borderRadius: 22` | Web: w-10 h-10 = 40px                                                        | **Should be 40×40** |
| `contactActionBtn` size            | `32×32`                   | OK for mobile touch                                                          | OK                  |
| `separator` marginLeft             | `76`                      | Hardcoded — should be avatar (44) + marginRight (12) + paddingLeft (16) = 72 | **Should be 72**    |
| `contactEmail` marginTop           | `1`                       | Non-standard                                                                 | Low                 |
| `contactCompany` marginTop         | `1`                       | Non-standard                                                                 | Low                 |
| `alphabetIndex` right              | `2`                       | Non-standard                                                                 | Low                 |
| `alphabetIndex` top                | `'20%'`                   | Hardcoded %                                                                  | Low                 |
| `alphabetLetter` paddingVertical   | `1`                       | Non-standard                                                                 | Low                 |
| `alphabetLetter` paddingHorizontal | `4`                       | `spacing.xs` (4) ✅                                                          | OK                  |

#### Webmail Discrepancies

| Area                    | RN Current                           | Webmail Pattern                            | Fix                                                                                 |
| ----------------------- | ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Contact avatar size** | 44px                                 | Web: w-10 = 40px                           | **Should be 40px (`componentSizes.avatarMd`)**                                      |
| **Search input height** | 40px                                 | Web: h-8 = 32px                            | **Should be 32px for web parity, but 40px is better for mobile touch** — keep as-is |
| **Header button size**  | 40×40                                | Web: 32×32                                 | **Should be 36×36 for mobile**                                                      |
| **Section header bg**   | `colors.background`                  | Web: bg-background ✅                      | Matches                                                                             |
| **Contact row padding** | `paddingVertical: spacing.md` (12px) | Web: var(--density-item-py) = 12px default | ✅ Matches                                                                          |
| **Empty state spacing** | `spacing.xxxl * 2` (64px)            | OK for mobile                              | OK                                                                                  |

---

### 5. SettingsScreenNew.tsx

#### Hardcoded Values

| Line/Style                    | Current Value                                      | Should Be                                                         | Priority           |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- | ------------------ |
| `profileAvatar` size          | `52×52, borderRadius: 26`                          | `componentSizes.avatarLg` (48)                                    | **Should be 48px** |
| `settingIcon` size            | `32×32`                                            | `componentSizes.avatarSm` (32) ✅                                 | OK                 |
| `planBadge` paddingHorizontal | `10`                                               | Non-standard — should be `spacing.sm` (8) or `spacing.md` (12)    | Low                |
| `planBadge` paddingVertical   | `4`                                                | `spacing.xs` (4) ✅                                               | OK                 |
| `sectionSeparator` marginLeft | `56`                                               | Hardcoded — should be icon(32) + padding(12) + gap(12) = 56       | OK (correct calc)  |
| `sectionTitle` letterSpacing  | `0.5`                                              | Matches web uppercase tracking                                    | ✅                 |
| `signOutBtn` borderColor      | `colors.error + '40'`                              | Inline opacity hack — needs proper token                          | **Medium**         |
| Hardcoded `iconBg` colors     | `'#faf5ff'`, `'#f0fdfa'`, `'#eef2ff'`, `'#fdf2f8'` | **These are light-mode Tailwind colors hardcoded in dark theme!** | **CRITICAL**       |

#### Webmail Discrepancies

| Area                       | RN Current                                 | Webmail Pattern                                    | Fix                                                        |
| -------------------------- | ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- |
| **Profile avatar**         | 52px                                       | Web: w-16 = 64px (detail) or w-12 = 48px (card)    | **Should be 48px**                                         |
| **Setting row padding**    | `spacing.md` (12px) vertical               | Web: py-3 = 12px ✅                                | Matches                                                    |
| **Toggle track colors**    | `surfaceActive`/`primaryLight`             | Web: --color-muted (off) / --color-primary (on)    | **Track off should be `colors.muted` or `colors.surface`** |
| **Toggle thumb**           | `colors.primary`/`colors.textMuted`        | Web: --color-background thumb                      | **Thumb should be `colors.background` (white circle)**     |
| **Section card bg**        | `colors.surface`                           | Web: bg-background with border                     | ✅ Works in dark                                           |
| **Hardcoded light iconBg** | `#faf5ff`, `#f0fdfa`, `#eef2ff`, `#fdf2f8` | These are Tailwind \*-50 values (LIGHT mode only!) | **CRITICAL: Use dark-mode equivalents**                    |

---

## PRIORITIZED FIX LIST

### 🔴 CRITICAL (Visual bugs / Wrong theme values)

| #   | Screen          | Issue                                                                                                    | Fix                                                                                                                |
| --- | --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | **Settings**    | Hardcoded light-mode icon backgrounds (`#faf5ff`, `#f0fdfa`, `#eef2ff`, `#fdf2f8`) in a dark theme       | Replace with dark equivalents: `'rgba(250,245,255,0.08)'` pattern or add `colors.calendar.*.bg` tokens             |
| 2   | **Settings**    | Toggle Switch colors wrong — track uses `surfaceActive`/`primaryLight`, thumb uses `primary`/`textMuted` | Track: `colors.surface` (off) / `colors.primary` (on). Thumb: always `colors.background`                           |
| 3   | **Calendar**    | Today circle uses solid fill (`backgroundColor: primary`)                                                | Web uses border/ring only. Change to `borderWidth: 2, borderColor: colors.primary, backgroundColor: 'transparent'` |
| 4   | **All screens** | `componentSizes` never imported — all sizes hardcoded                                                    | Import and use `componentSizes` for avatars, buttons, inputs consistently                                          |

### 🟠 HIGH (Noticeable sizing/spacing differences)

| #   | Screen          | Issue                                                                       | Fix                                                       |
| --- | --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| 5   | **EmailThread** | Back arrow is 22px, should be 20px                                          | Change to `20`                                            |
| 6   | **EmailThread** | Toolbar buttons 40×40, web is 32×32                                         | Change to `componentSizes.avatarSm` (32) or 36 for mobile |
| 7   | **EmailThread** | Subject area padding too small (8px top)                                    | Change `paddingTop: spacing.sm` → `spacing.xxl` (24px)    |
| 8   | **EmailThread** | Email body should use `typography.base` (16px) not `typography.body` (14px) | Use `base` for actual email content                       |
| 9   | **Compose**     | Quote border width 3px, web is 2px                                          | Change to `2`                                             |
| 10  | **Compose**     | Format toolbar buttons 40×36, web is 32×32                                  | Change to 32×32 or 36×36                                  |
| 11  | **Compose**     | Send button has no explicit height (auto ~32px), web is 36px                | Add `height: componentSizes.buttonSm` (36)                |
| 12  | **Calendar**    | Event dot 5×5, token says 6×6                                               | Change to `componentSizes.eventDot` (6)                   |
| 13  | **Calendar**    | Event color bar width 4px, web is 3px                                       | Change to `3`                                             |
| 14  | **Contacts**    | Avatar 44px, web is 40px                                                    | Change to `componentSizes.avatarMd` (40)                  |
| 15  | **Settings**    | Profile avatar 52px, web uses 48px                                          | Change to `componentSizes.avatarLg` (48)                  |

### 🟡 MEDIUM (Minor visual polish)

| #   | Screen          | Issue                                                                      | Fix                                                                       |
| --- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 16  | **EmailThread** | `messageAvatarText` fontSize 15, no matching token                         | Use `typography.body.fontSize` (14)                                       |
| 17  | **EmailThread** | `messageCardLast` borderColor uses `+ '30'` inline hack                    | Add `colors.primaryBorder` token or use `colors.selection`                |
| 18  | **Settings**    | `signOutBtn` borderColor uses `+ '40'` inline hack                         | Add `colors.errorBorder` token or use `rgba(239,68,68,0.25)`              |
| 19  | **Calendar**    | Day number 34×34 — non-standard                                            | Change to 36 (`componentSizes.buttonSm`)                                  |
| 20  | **Calendar**    | Empty state icon uses `surfaceActive`                                      | Should be `colors.textMuted`                                              |
| 21  | **Compose**     | Input fields have no borders                                               | Add `borderWidth: 1, borderColor: colors.border, borderRadius: radius.xs` |
| 22  | **Contacts**    | Separator marginLeft hardcoded 76                                          | Calculate from avatar(40) + spacing.md(12) + spacing.lg(16) = 68          |
| 23  | **All**         | Many non-standard spacing values (1, 2, 3, 6, 10) not aligning to 4px grid | Audit each and round to nearest `spacing.*` token                         |

### 🟢 LOW (Nice-to-have / Cleanup)

| #   | Screen       | Issue                                                                    | Fix                                              |
| --- | ------------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| 24  | **Compose**  | `fieldSeparator` has `height: 0` — dead style                            | Remove it                                        |
| 25  | **All**      | Gap values of `2` used in several places                                 | Change to `spacing.xs` (4) minimum               |
| 26  | **Calendar** | `headerSubtitle` marginTop: 2                                            | Use `spacing.xs` (4) or remove                   |
| 27  | **Contacts** | `contactEmail`/`contactCompany` marginTop: 1                             | Use `2` minimum                                  |
| 28  | **All**      | Inline opacity hacks (appending `'20'`, `'30'`, `'40'` to color strings) | Create proper opacity tokens or utility function |

---

## NEW TOKENS RECOMMENDED

Add these to `tokens.ts`:

```typescript
// Add to colors:
colors.primaryBorder: 'rgba(59, 130, 246, 0.19)',  // primary + '30' replacement
colors.errorBorder: 'rgba(239, 68, 68, 0.25)',     // error + '40' replacement

// Add to colors.calendar (dark-mode icon backgrounds):
colors.calendar.purpleBg: 'rgba(167, 139, 250, 0.08)',  // replaces #faf5ff
colors.calendar.tealBg: 'rgba(45, 212, 191, 0.08)',     // replaces #f0fdfa
colors.calendar.indigoBg: 'rgba(129, 140, 248, 0.08)',  // replaces #eef2ff
colors.calendar.pinkBg: 'rgba(244, 114, 182, 0.08)',    // replaces #fdf2f8
colors.calendar.orangeBg: 'rgba(251, 191, 36, 0.08)',   // replaces warningBg already exists

// Or better: a utility function
export function withOpacity(color: string, opacity: number): string {
  // Parse hex and return rgba
}
```

---

## SUMMARY STATISTICS

| Metric                          | Count                  |
| ------------------------------- | ---------------------- |
| Total unique issues found       | 28                     |
| 🔴 Critical fixes               | 4                      |
| 🟠 High priority                | 11                     |
| 🟡 Medium priority              | 8                      |
| 🟢 Low priority                 | 5                      |
| Unused color tokens             | 27                     |
| Unused typography tokens        | 6                      |
| Unused spacing tokens           | 1 (`xxl`)              |
| `componentSizes` usage          | **0** (never imported) |
| Hardcoded non-token values      | ~35 instances          |
| Inline opacity hacks (`+ 'XX'`) | 3 instances            |
| Light-mode colors in dark theme | 4 values in Settings   |
