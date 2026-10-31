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
// - Push renewal (PushRenewal.swift): Stalwart drops a subscription seven days
//   after its last refresh. The extension extends the pushed account's, and
//   the app (PushRenewalTask.swift, compiled into the app target) every
//   account's on foreground and from a background app refresh task, which
//   AppDelegate registers at launch and Info.plist permits.
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
  IOSConfig,
  withAppDelegate,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  withDangerousMod,
  createRunOncePlugin,
} = require('@expo/config-plugins');
const { addTargetFiles, hasTarget } = require('../ios-target-files');

const TARGET = 'NotificationService';
const DEPLOYMENT_TARGET = '15.1';
const SOURCE_FILES = ['NotificationService.swift', 'SharedKeychain.swift', 'Jmap.swift', 'PushRenewal.swift'];
// Compiled into the app as well: the renewal on foreground and in the
// background refresh task.
const APP_SOURCE_FILES = ['SharedKeychain.swift', 'Jmap.swift', 'PushRenewal.swift', 'PushRenewalTask.swift'];
// PushRenewalTask.identifier
const RENEWAL_TASK_ID = 'org.bulwarkmail.mobile.push-renewal';
const RENEWAL_REGISTER_CALL = 'PushRenewalTask.register()';
// Where Expo's AppDelegate.swift hands launch to its superclass; the
// registration has to run before that returns (Expo's Maps plugin uses the
// same anchor).
const APP_DELEGATE_LAUNCH = /^([ \t]*)return super\.application\(\w+, didFinishLaunchingWithOptions: \w+\)/m;

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
      const appDir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      for (const file of APP_SOURCE_FILES) {
        fs.copyFileSync(path.join(__dirname, file), path.join(appDir, file));
      }
      return cfg;
    },
  ]);
}

/** Compile the renewal sources into the app target. */
function addAppSources(cfg) {
  const projectName = cfg.modRequest.projectName;
  for (const file of APP_SOURCE_FILES) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/${file}`,
      groupName: projectName,
      project: cfg.modResults,
    });
  }
}

/**
 * The app's Info.plist entries for the renewal: the refresh task id, the
 * background mode it needs, and the keychain group SharedKeychain reads
 * (the extension's Info.plist names the same group).
 */
function setRenewalInfoPlist(plist, { teamId }) {
  const ids = new Set(plist.BGTaskSchedulerPermittedIdentifiers ?? []);
  ids.add(RENEWAL_TASK_ID);
  plist.BGTaskSchedulerPermittedIdentifiers = [...ids];
  const modes = new Set(plist.UIBackgroundModes ?? []);
  modes.add('fetch');
  plist.UIBackgroundModes = [...modes];
  plist.BulwarkKeychainGroup = `${teamId || '$(DEVELOPMENT_TEAM)'}.${sharedGroupSuffix()}`;
  return plist;
}

/** AppDelegate.swift with the renewal task registered during launch. */
function addRenewalToAppDelegate(contents) {
  if (contents.includes(RENEWAL_REGISTER_CALL)) return contents;
  if (!APP_DELEGATE_LAUNCH.test(contents)) {
    throw new Error('plugins/ios-push: AppDelegate.swift has no didFinishLaunching return to register push renewal before');
  }
  return contents.replace(
    APP_DELEGATE_LAUNCH,
    (line, indent) => `${indent}// plugins/ios-push: BGTaskScheduler handlers must exist before launch ends.\n${indent}${RENEWAL_REGISTER_CALL}\n${line}`,
  );
}

function withRenewal(config, { teamId }) {
  config = withInfoPlist(config, (cfg) => {
    setRenewalInfoPlist(cfg.modResults, { teamId });
    return cfg;
  });
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('plugins/ios-push: push renewal expects a Swift AppDelegate');
    }
    cfg.modResults.contents = addRenewalToAppDelegate(cfg.modResults.contents);
    return cfg;
  });
  return config;
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
    addAppSources(cfg);
    setReleaseProfiles(cfg, { appProfile, extensionProfile });
    return cfg;
  });
}

function addExtensionTarget(cfg, { teamId }) {
    const project = cfg.modResults;
    if (hasTarget(project, TARGET)) return;

    // addTarget expects these sections; a fresh Expo project may not have them.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

    const bundleId = `${cfg.ios.bundleIdentifier}.${TARGET}`;
    const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    // Its own group and file references: the app and the widget compile
    // copies of some of these files (plugins/ios-target-files.js).
    addTargetFiles(project, {
      name: TARGET,
      targetUuid: target.uuid,
      sources: SOURCE_FILES,
      files: [`${TARGET}-Info.plist`, `${TARGET}.entitlements`],
    });
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
  config = withRenewal(config, { teamId });
  return config;
}

module.exports = createRunOncePlugin(withIosPush, 'bulwark-ios-push', '1.0.0');
// For the tests (src/lib/__tests__/ios-push-renewal.test.ts).
module.exports.internals = { addRenewalToAppDelegate, setRenewalInfoPlist, SOURCE_FILES, APP_SOURCE_FILES, RENEWAL_TASK_ID };
