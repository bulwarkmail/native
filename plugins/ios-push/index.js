// Config plugin: push notifications on iOS.
//
// - The app's entitlements: aps-environment, and a keychain group shared with
//   the notification service extension (the app's own group stays first, so
//   items saved before keep their group).
// - A Notification Service Extension target ("NotificationService",
//   org.bulwarkmail.mobile.NotificationService). The relay's push carries
//   only ids; the extension fetches sender and subject over JMAP on the device
//   before iOS shows the notification. Its sources live next to this file and
//   are copied into ios/ at prebuild, like everything else in ios/.
//
// Options (app.config.js):
//   apsEnvironment: 'production' | 'development' (APS_ENVIRONMENT env wins)
//   teamId: Apple team id, for the shared keychain group
//   extensionProfile / appProfile: provisioning profile specifiers for the
//     Release configuration of the extension and the app (IOS_NSE_PROFILE and
//     IOS_APP_PROFILE env win). Set per target because xcodebuild's command
//     line applies a specifier to every target. Empty = leave unset.

const fs = require('node:fs');
const path = require('node:path');
const {
  withEntitlementsPlist,
  withXcodeProject,
  withDangerousMod,
  createRunOncePlugin,
} = require('@expo/config-plugins');

const TARGET = 'NotificationService';
const DEPLOYMENT_TARGET = '15.1';
const SOURCE_FILES = ['NotificationService.swift', 'SharedKeychain.swift', 'Jmap.swift'];

function sharedGroupSuffix() {
  return 'org.bulwarkmail.shared';
}

function withAppEntitlements(config, { apsEnvironment }) {
  return withEntitlementsPlist(config, (cfg) => {
    const bundleId = cfg.ios?.bundleIdentifier;
    cfg.modResults['aps-environment'] = apsEnvironment;
    const groups = new Set(cfg.modResults['keychain-access-groups'] ?? []);
    groups.add(`$(AppIdentifierPrefix)${bundleId}`);
    groups.add(`$(AppIdentifierPrefix)${sharedGroupSuffix()}`);
    cfg.modResults['keychain-access-groups'] = [...groups];
    return cfg;
  });
}

function infoPlist({ version, buildNumber }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Bulwark Mail notifications</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${buildNumber}</string>
  <key>BulwarkKeychainGroup</key>
  <string>$(DEVELOPMENT_TEAM).${sharedGroupSuffix()}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
}

function entitlementsPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>$(AppIdentifierPrefix)${sharedGroupSuffix()}</string>
  </array>
</dict>
</plist>
`;
}

function withExtensionFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of SOURCE_FILES) {
        fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
      }
      fs.writeFileSync(
        path.join(dir, `${TARGET}-Info.plist`),
        infoPlist({ version: cfg.version, buildNumber: cfg.ios?.buildNumber ?? '1' }),
      );
      fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), entitlementsPlist());
      return cfg;
    },
  ]);
}

function setReleaseProfiles(cfg, { appProfile, extensionProfile }) {
    if (!appProfile && !extensionProfile) return;
    const project = cfg.modResults;
    const appName = `"${cfg.modRequest.projectName}"`;
    const configs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const entry = configs[key];
      if (!entry.buildSettings || entry.name !== 'Release') continue;
      const name = entry.buildSettings.PRODUCT_NAME;
      const profile = name === `"${TARGET}"` ? extensionProfile
        : (name === appName || name === '"$(TARGET_NAME)"') && entry.buildSettings.PRODUCT_BUNDLE_IDENTIFIER ? appProfile
          : '';
      if (profile) entry.buildSettings.PROVISIONING_PROFILE_SPECIFIER = `"${profile}"`;
    }
}

// One mod for creating the target and naming the profiles: separate
// withXcodeProject mods don't run in the order they are registered.
function withExtensionTarget(config, { teamId, appProfile, extensionProfile }) {
  return withXcodeProject(config, (cfg) => {
    addExtensionTarget(cfg, { teamId });
    setReleaseProfiles(cfg, { appProfile, extensionProfile });
    return cfg;
  });
}

function addExtensionTarget(cfg, { teamId }) {
    const project = cfg.modResults;
    if (project.pbxTargetByName(TARGET)) return;

    // addTarget expects these sections; a fresh Expo project may not have them.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

    const group = project.addPbxGroup(
      [...SOURCE_FILES, `${TARGET}-Info.plist`, `${TARGET}.entitlements`],
      TARGET,
      TARGET,
    );
    // Hang the group off the project's main group.
    const mainGroupId = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroupId);

    const bundleId = `${cfg.ios.bundleIdentifier}.${TARGET}`;
    const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    project.addBuildPhase(SOURCE_FILES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    const configs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const entry = configs[key];
      if (!entry.buildSettings || entry.buildSettings.PRODUCT_NAME !== `"${TARGET}"`) continue;
      const s = entry.buildSettings;
      s.CODE_SIGN_ENTITLEMENTS = `${TARGET}/${TARGET}.entitlements`;
      s.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
      s.TARGETED_DEVICE_FAMILY = '"1,2"';
      s.SWIFT_VERSION = '5.0';
      s.CLANG_ENABLE_MODULES = 'YES';
      s.GENERATE_INFOPLIST_FILE = 'NO';
      if (teamId) s.DEVELOPMENT_TEAM = teamId;
    }
}

function withIosPush(config, options = {}) {
  const apsEnvironment = process.env.APS_ENVIRONMENT || options.apsEnvironment || 'production';
  const teamId = process.env.APPLE_TEAM_ID || options.teamId || '';
  const extensionProfile = process.env.IOS_NSE_PROFILE || options.extensionProfile || '';
  const appProfile = process.env.IOS_APP_PROFILE || options.appProfile || '';
  config = withAppEntitlements(config, { apsEnvironment });
  config = withExtensionFiles(config);
  config = withExtensionTarget(config, { teamId, appProfile, extensionProfile });
  return config;
}

module.exports = createRunOncePlugin(withIosPush, 'bulwark-ios-push', '1.0.0');
