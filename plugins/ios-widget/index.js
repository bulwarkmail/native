// Config plugin: the iOS inbox widget (WidgetKit).
//
// - A widget extension target ("BulwarkWidget", org.bulwarkmail.mobile.Widget)
//   built from BulwarkWidget.swift, plus SharedKeychain.swift from
//   plugins/ios-push: the widget reads what it shows from the keychain group
//   the app shares with its extensions (src/widgets/ios.ts writes it). No app
//   group: that would need a new capability on every provisioning profile.
// - The BulwarkWidgetKit native module in the app (BulwarkWidgetKit.swift/.m),
//   which reloads the widget after the app wrote new data.
//
// Signing: a signed build names a profile per target. When the app's profile
// is given (IOS_APP_PROFILE, the release workflow) but no widget profile
// (IOS_WIDGET_PROFILE), the widget target is left out so the archive still
// signs; the simulator and unsigned builds always include it.

const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject, createRunOncePlugin } = require('@expo/config-plugins');
const { withAppSources } = require('../ios-app-sources');

const TARGET = 'BulwarkWidget';
const DEPLOYMENT_TARGET = '15.1';
const SHARED_GROUP_SUFFIX = 'org.bulwarkmail.shared';
// The widget's own sources, and the ones it borrows from plugins/ios-push.
const WIDGET_FILES = ['BulwarkWidget.swift'];
const BORROWED_FILES = ['SharedKeychain.swift'];
const SOURCE_FILES = [...WIDGET_FILES, ...BORROWED_FILES];
const APP_FILES = ['BulwarkWidgetKit.swift', 'BulwarkWidgetKit.m'];

function infoPlist({ version, buildNumber }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Bulwark Mail</string>
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
  <string>$(DEVELOPMENT_TEAM).${SHARED_GROUP_SUFFIX}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
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
    <string>$(AppIdentifierPrefix)${SHARED_GROUP_SUFFIX}</string>
  </array>
</dict>
</plist>
`;
}

/** Whether this build gets the widget target (see the signing note above). */
function includeWidget({ appProfile, widgetProfile }) {
  return !appProfile || !!widgetProfile;
}

function withWidgetFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of WIDGET_FILES) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
      for (const file of BORROWED_FILES) fs.copyFileSync(path.join(__dirname, '../ios-push', file), path.join(dir, file));
      fs.writeFileSync(
        path.join(dir, `${TARGET}-Info.plist`),
        infoPlist({ version: cfg.version, buildNumber: cfg.ios?.buildNumber ?? '1' }),
      );
      fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), entitlementsPlist());
      return cfg;
    },
  ]);
}

function addWidgetTarget(cfg, { teamId, widgetProfile }) {
  const project = cfg.modResults;
  if (project.pbxTargetByName(TARGET)) return;

  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

  const group = project.addPbxGroup(
    [...SOURCE_FILES, `${TARGET}-Info.plist`, `${TARGET}.entitlements`],
    TARGET,
    TARGET,
  );
  const mainGroupId = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroupId);

  const bundleId = `${cfg.ios.bundleIdentifier}.Widget`;
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
    if (widgetProfile && entry.name === 'Release') s.PROVISIONING_PROFILE_SPECIFIER = `"${widgetProfile}"`;
  }
}

function withIosWidget(config, options = {}) {
  const teamId = process.env.APPLE_TEAM_ID || options.teamId || '';
  const appProfile = process.env.IOS_APP_PROFILE || options.appProfile || '';
  const widgetProfile = process.env.IOS_WIDGET_PROFILE || options.widgetProfile || '';
  config = withAppSources(config, { dir: __dirname, files: APP_FILES });
  if (!includeWidget({ appProfile, widgetProfile })) {
    console.warn('plugins/ios-widget: IOS_APP_PROFILE is set but IOS_WIDGET_PROFILE is not; building without the widget.');
    return config;
  }
  config = withWidgetFiles(config);
  config = withXcodeProject(config, (cfg) => {
    addWidgetTarget(cfg, { teamId, widgetProfile });
    return cfg;
  });
  return config;
}

module.exports = createRunOncePlugin(withIosWidget, 'bulwark-ios-widget', '1.0.0');
// For the tests (src/widgets/__tests__/ios-widget.test.ts).
module.exports.internals = { includeWidget, infoPlist, entitlementsPlist, SOURCE_FILES, APP_FILES, TARGET };
