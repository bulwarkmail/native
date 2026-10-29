<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# Bulwark Mobile

> **Beta - work in progress.** Many features are unfinished or rough. Expect bugs, missing functionality, and breaking changes between releases. Do not rely on this for primary email yet.

React Native (Expo SDK 54) client for [Bulwark Webmail](https://github.com/bulwarkmail/webmail) - a JMAP-based mail, calendar, and contacts app.

## Try it

- **iPhone and iPad:** join the beta on TestFlight: https://testflight.apple.com/join/rumcjNSp. A new release shows up there once Apple has reviewed it, usually within a day.
- **Android:** download the APK from the [latest release](https://github.com/bulwarkmail/native/releases/latest).

## What works today

- Sign in to any JMAP server (e.g. Stalwart)
- Multiple accounts
- Email list, threads, compose
- Calendar (basic)
- Contacts (basic)
- Push notifications via the Bulwark relay - FCM by default, or [UnifiedPush](https://unifiedpush.org) (e.g. ntfy) for devices without Google Play services
- Android: contacts and calendars sync both ways with the phone's Contacts and Calendar apps (Settings → Contacts / Calendar → Sync to this device)
- In-app sideload updates from GitHub Releases

## What's missing or rough

- iOS builds, but push notifications, client certificates and syncing with the phone's contacts and calendars are Android-only so far
- S/MIME, plugins, themes - UI stubs only (filters & rules, the vacation responder and file storage are real implementations)
- Calendar editing is partial; contacts editing is basic
- No Play Store or App Store listing yet: Android is a sideloaded APK, iOS a TestFlight beta (see [Try it](#try-it))

## Run locally

```bash
npm install
npx expo start
```

Then press `a` for Android, `i` for iOS, or scan the QR with Expo Go.

For release APK builds and signing see [docs/android-release.md](docs/android-release.md).
For iOS builds and TestFlight distribution see [docs/ios-release.md](docs/ios-release.md).

## License

AGPL-3.0-only, with an additional permission to distribute the app through app stores such as the Apple App Store and Google Play. See [LICENSE](LICENSE). Contributions are accepted under the same terms. The permission is provisional until every earlier contributor has agreed to it ([consent request](https://github.com/orgs/bulwarkmail/discussions/1113)); contributions made since 30 September 2026 are already covered.
