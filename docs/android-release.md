# Android release signing

The release APK is built by
[.github/workflows/release-android.yml](../.github/workflows/release-android.yml)
on an Ubuntu runner whenever a GitHub release is published, and attached to that
release. Installed apps pick it up through the in-app updater.

Every APK up to and including 0.1.62 was signed with `android/app/debug.keystore`,
the debug key that ships with the React Native template. Its password is
`android` and copies of it are everywhere, so anyone could sign an APK that
Android accepts as an update to Bulwark Mobile. Such an "update" runs as the
app, with its accounts, SecureStore credentials and mail cache. This is
[S2 in the 2026-09 audit](audit-2026-09.md#s2).

Release builds now need a real key:

- `android/app/build.gradle` reads the key from `BULWARK_RELEASE_*` properties.
  Without them, a release build fails in `checkReleaseSigning` before anything
  is packaged. Debug builds and `npx expo run:android` are not affected.
- The workflow fails in its first step when a signing secret is missing, checks
  the key before the build, and refuses to upload an APK that Android 9+ would
  not see as signed by the release key.
- `versionCode` now comes from `VERSION` (see [versionCode](#versioncode)).

## One-time setup

The commands are for Git Bash on Windows, run from the repository root. They
need `keytool`, which ships with every JDK, and `apksigner` from the Android SDK
build-tools. Its `.jar` runs on Java 8 or newer:

```bash
apksigner() { java -jar "$LOCALAPPDATA/Android/Sdk/build-tools/36.0.0/lib/apksigner.jar" "$@"; }
```

On macOS or Linux, call `$ANDROID_HOME/build-tools/36.0.0/apksigner` instead.

### 1. Generate the release key

```bash
read -rsp 'Keystore password: ' BULWARK_KS_PASS; echo; export BULWARK_KS_PASS
keytool -genkeypair -v -storetype PKCS12 -keystore bulwark-release.p12 \
  -alias bulwark -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Bulwark Mail, O=Bulwark Mail" \
  -storepass:env BULWARK_KS_PASS -keypass:env BULWARK_KS_PASS
```

`-validity 10000` is about 27 years. A PKCS12 keystore uses one password for
the store and the key, so `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD`
below get the same value. `*.p12` is gitignored, but move the file out of the
checkout once the secrets are set.

**Back up `bulwark-release.p12` and its password in two places**, for example
a password manager and an offline copy. If the key is lost, no later APK can
update an installed app: every user has to uninstall, which loses their accounts
and local data, and install again. If the key leaks, you are back where S2
started.

The certificate's SHA-256 is what the workflow log prints as the release key:

```bash
keytool -exportcert -keystore bulwark-release.p12 -alias bulwark \
  -storepass:env BULWARK_KS_PASS | sha256sum
```

### 2. Create the rotation lineage

Skip this and the first release signed with the new key cannot be installed
over any existing install. Android reports "App not installed as package
conflicts with an existing package", and every user has to uninstall and
reinstall.

APK Signature Scheme v3, read by Android 9 and newer, lets an APK carry a
*signing lineage*: a record signed by the old key that names the new key as its
successor. The old key here is the public debug key, so you can create that
record yourself:

```bash
apksigner rotate --out bulwark.lineage \
  --old-signer --ks android/app/debug.keystore --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android \
    --set-installed-data true --set-rollback false \
    --set-permission false --set-auth false --set-shared-uid false \
  --new-signer --ks bulwark-release.p12 --ks-key-alias bulwark \
    --ks-pass env:BULWARK_KS_PASS --key-pass env:BULWARK_KS_PASS
apksigner lineage --in bulwark.lineage --print-certs
```

The `--set-*` flags on the old signer decide what the debug key can still do on
a device that has moved to the new key:

- `--set-installed-data true` lets the new key take over an install made with
  the debug key. Without it the rotation does nothing.
- `--set-rollback false` keeps an APK signed with the debug key from being
  accepted again afterwards. With `true` the rotation would be pointless, and the
  workflow refuses such a lineage.
- `--set-permission false` stops granting the app's signature permissions to
  apps signed with the debug key, which includes every React Native debug build.
  The merged manifest defines one,
  `com.anonymous.bulwarkmobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. It
  guards the receivers that are registered as not exported on Android 12L and
  older.
- `--set-auth false` and `--set-shared-uid false`: the app uses neither.

The lineage holds only certificates and a signature made with the debug key, so
it is not secret. It is stored as a secret only so the workflow can find it.

### 3. Repository secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `bulwark-release.p12`, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | `bulwark` |
| `ANDROID_KEY_PASSWORD` | The same password again |
| `ANDROID_SIGNING_LINEAGE_BASE64` | `bulwark.lineage`, base64-encoded. Optional, but see step 2 |

With the GitHub CLI, from the checkout and in the same shell as step 1:

```bash
base64 -w0 bulwark-release.p12 | gh secret set ANDROID_KEYSTORE_BASE64
printf %s "$BULWARK_KS_PASS" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf %s "$BULWARK_KS_PASS" | gh secret set ANDROID_KEY_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body bulwark
base64 -w0 bulwark.lineage | gh secret set ANDROID_SIGNING_LINEAGE_BASE64
```

Or copy a file as base64 for the web form:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('bulwark-release.p12')) | Set-Clipboard
```

## The first release with the new key

1. Set all five secrets.
2. Release as usual with `npm run bump`.
3. In the workflow run, "Verify the APK signature" prints the release key's
   SHA-256 as the Android 9+ signer and `fac61745…3b9c`, the debug key, as the
   Android 7-8.1 signer, followed by a warning about the latter. The warning is
   expected for as long as the lineage is used.
4. Check it on the emulators before you announce anything:
   - Install 0.1.62 (`gh release download 0.1.62 -p '*.apk'`) on
     `Pixel_6_Pro_API_32` and `Pixel_7_API_34` and sign in. Then `adb install -r`
     the new APK. It has to install over 0.1.62 and keep the account.
   - Set `VERSION` above the new release locally (don't commit it), build with
     `-PallowDebugSignedRelease=true` (see [Local release builds](#local-release-builds))
     and `adb install -r` that APK over the updated app. It has to fail with
     `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
5. Add a line `severity: security` to the release notes (web UI or
   `gh release edit`). The in-app update banner then cannot be dismissed, which
   matters because a device on 0.1.62 accepts a debug-signed "update" until it
   has installed this release.

## What rotation does and does not protect

| Device | After it installs a rotated release |
| --- | --- |
| Android 9 and newer (API 28+) | Updates in place and keeps accounts and data. From then on it accepts only updates signed with the release key. An APK signed with the debug key is refused, and so is one that carries a lineage from the debug key to some other key. |
| Android 7.0-8.1 (API 24-27) | Updates in place, but these versions do not read v3 signatures. They check the v2 signature, which the workflow still makes with the debug key so that they can update at all. They keep accepting debug-signed "updates". |

What it does not cover:

- **Devices that have not updated yet.** Until a device installs a rotated
  release it trusts the debug key as before. Whoever gets a debug-signed APK onto
  it first can attach a lineage to their own key and keep the app for good. The
  window closes for each device when it updates, which is why the release should
  carry `severity: security`.
- **Android 7.0-8.1**, as long as the lineage is used. New installs on those
  versions also start out trusting the debug key. The only fix is
  [ending the migration](#ending-the-migration), after which they need a
  reinstall.
- **Anything that already happened.** Rotation does not repair a device that
  already runs a malicious "update".
- **The release key itself.** Rotation moves the trust to
  `bulwark-release.p12`. It is only as safe as that file and its password.

The workflow passes `--rotation-min-sdk-version 28` to `apksigner sign`. By
default apksigner puts the rotated key in a v3.1 block that only Android 13+
reads and signs the v3.0 block with the old key, which would leave Android
9-12L on the debug key.

If you restricted the Firebase API key in `google-services.json` to Android apps
by certificate fingerprint in the Google Cloud console, add the release key's
SHA-1 there before the first release and keep the debug key's entry until the
migration has ended. Otherwise push registration can fail. An unrestricted key
needs nothing.

## Ending the migration

Keep `ANDROID_SIGNING_LINEAGE_BASE64` set while installs of 0.1.62 or older may
still be around: without it they cannot update at all.

Once you delete it, every APK is signed with the release key alone:

- Devices that already moved to the release key keep updating normally.
- Anything still on 0.1.62 or older, and every Android 7.0-8.1 install, refuses
  the update. Those users have to uninstall, reinstall and sign in again, and
  they lose local data. Afterwards their devices trust only the release key.

## Local release builds

CI signs releases, so you normally don't need the release key on your machine.
For a local release build, for profiling or checking R8, opt in to the debug key:

```bash
cd android
./gradlew assembleRelease -PallowDebugSignedRelease=true
```

```powershell
$env:ORG_GRADLE_PROJECT_allowDebugSignedRelease = 'true'
npx expo run:android --variant release
```

The build prints a warning. The APK is signed with the public key, so never
give it to anyone. On a device that has moved to the release key it will not
install over the official app; uninstall that first. `allowDebugSignedRelease`
is ignored when the `CI` environment variable is set, so the workflow cannot
use it.

To sign locally with the real key, set these as `-P` flags, in
`~/.gradle/gradle.properties` or as environment variables. Never put them in
`android/gradle.properties`, which is committed.

```properties
BULWARK_RELEASE_STORE_FILE=C:/Users/you/keys/bulwark-release.p12
BULWARK_RELEASE_STORE_PASSWORD=...
BULWARK_RELEASE_KEY_ALIAS=bulwark
BULWARK_RELEASE_KEY_PASSWORD=...
```

That APK has no lineage, so it will not install over a debug-signed install
either.

With neither, a release build stops and lists what is missing. Debug builds and
`npx expo run:android` never need any of this.

## Stack traces

Release builds are shrunk and obfuscated by R8, so library frames in a crash
report look like `com.facebook.react.uimanager.U.a`. The app's own classes
(`com.anonymous.bulwarkmobile`) keep their names. The workflow attaches
`bulwark-mobile-<version>-<commit>-mapping.txt` to the release next to the APK
and keeps it as a workflow artifact. Decode a trace with the mapping of that
exact build:

```bash
retrace bulwark-mobile-0.1.63-abc1234-mapping.txt stacktrace.txt
```

`retrace` is in the Android SDK command-line tools (`cmdline-tools/latest/bin`).
A local build writes its mapping to
`android/app/build/outputs/mapping/release/mapping.txt`.

## versionCode

`versionCode` was `1` for every release up to 0.1.62. It is now derived from
`VERSION` in `android/app/build.gradle`:

```
major * 10000000 + minor * 10000 + patch        0.1.63 -> 10063
```

Android refuses an update whose `versionCode` is lower than the installed one,
so the number may only grow. The formula keeps growing while patch stays below
10000 and minor below 1000, and `npm run bump` refuses to go past either. It
stays under Android's limit of 2100000000 up to major 209. Existing installs
have `versionCode` 1, so the first release with this change updates them
normally.

Never switch to a formula that gives smaller numbers: installed apps would
refuse every update until the numbers caught up.

## Rotating again

If the release key ever has to change, extend the lineage instead of starting
a new one. Generate `bulwark-release-2.p12` as in step 1, with its password in
`NEW_KS_PASS`:

```bash
apksigner rotate --in bulwark.lineage --out bulwark-2.lineage \
  --old-signer --ks bulwark-release.p12 --ks-key-alias bulwark \
    --ks-pass env:BULWARK_KS_PASS --key-pass env:BULWARK_KS_PASS --set-rollback false \
  --new-signer --ks bulwark-release-2.p12 --ks-key-alias bulwark \
    --ks-pass env:NEW_KS_PASS --key-pass env:NEW_KS_PASS
```

Then update the secrets. The workflow accepts any lineage that starts at the
debug key and ends at the key in `ANDROID_KEYSTORE_BASE64`, and refuses one in
which an earlier key has the rollback capability. As with the first rotation,
only Android 9+ devices that install the new release follow it. If the old key
leaked, a device that someone reached first stays theirs.
