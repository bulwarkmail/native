<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# Bulwark Mobile

> **Beta - work in progress.** Many features are unfinished or rough. Expect bugs, missing functionality, and breaking changes between releases. Do not rely on this for primary email yet.

React Native (Expo SDK 54) client for [Bulwark Webmail](https://github.com/bulwarkmail/webmail) - a JMAP-based mail, calendar, and contacts app.

## What works today

- Sign in to any JMAP server (e.g. Stalwart)
- Multiple accounts
- Email list, threads, compose
- Calendar (basic)
- Contacts (basic)
- Push notifications via FCM relay
- In-app sideload updates from GitHub Releases

## What's missing or rough

- iOS build is untested
- Filters & rules, S/MIME, plugins, themes, file storage - UI stubs only
- Calendar editing is partial; contacts editing is basic
- No Play Store distribution yet (sideload APK from Releases)

## Run locally

```bash
npm install
npx expo start
```

Then press `a` for Android, `i` for iOS, or scan the QR with Expo Go.

For a release APK build see [.github/workflows/release-android.yml](.github/workflows/release-android.yml).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
