// UIScene life cycle for builds with the iOS 27 SDK (Xcode 27).
//
// The iOS 27 SDK refuses to launch an app that has not adopted scenes
// ("UIScene life cycle is required for apps built with this SDK"), and Expo
// ships a scene delegate only from SDK 57.0.23. Until the app is on such an
// SDK this plugin adopts scenes itself: it declares the scene manifest and
// moves the window and React Native's start from the app delegate into a
// scene delegate. The manifest alone is not enough: UIKit then creates the
// scene, but a window made with UIWindow(frame:) is never attached to it and
// the app stays black.
//
// After expo/expo#50179. The scene delegate is appended to AppDelegate.swift
// so the Xcode project needs no new file reference.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const MARKER = '// plugins/ios-scene-lifecycle';

const WINDOW_RE = /^[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)\r?\n/m;
const START_RE = /^[ \t]*factory\.startReactNative\(\r?\n[\s\S]*?launchOptions: launchOptions\)\r?\n/m;
const WINDOW_PROPERTY = '  var window: UIWindow?\n';

const SCENE_DELEGATE = `
${MARKER}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else {
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // React Native and Expo modules still look for the app delegate's window.
    appDelegate.window = window
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions)
    // With scenes, a link that starts the app arrives here and
    // application(_:open:options:) is never called.
    open(connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities {
      self.scene(scene, continue: activity)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = UIApplication.shared.delegate?.application?(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  // Through the app delegate, whose override hands the link to Expo's
  // subscribers and to RCTLinkingManager, once.
  private func open(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      _ = UIApplication.shared.delegate?.application?(UIApplication.shared, open: context.url, options: [:])
    }
  }
}
`;

// AppDelegate.swift with the window and React Native's start moved into the
// scene delegate. Unchanged when it already was; throws when a line it moves
// is not there, rather than leaving an app that starts black.
function moveStartToSceneDelegate(contents) {
  if (contents.includes(MARKER)) return contents;
  for (const [found, what] of [
    [WINDOW_RE.test(contents), 'window creation'],
    [START_RE.test(contents), 'startReactNative call'],
    [contents.includes(WINDOW_PROPERTY), 'window property'],
  ]) {
    if (!found) {
      throw new Error(`ios-scene-lifecycle: AppDelegate.swift has no ${what}; the Expo template changed`);
    }
  }
  return contents
    .replace(WINDOW_RE, '    // The window and React Native start in SceneDelegate (plugins/ios-scene-lifecycle).\n    self.launchOptions = launchOptions\n')
    .replace(START_RE, '')
    .replace(WINDOW_PROPERTY, `${WINDOW_PROPERTY}  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n`)
    + SCENE_DELEGATE;
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    cfg.modResults.contents = moveStartToSceneDelegate(cfg.modResults.contents);
    return cfg;
  });
}

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ],
  },
};

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = SCENE_MANIFEST;
    return cfg;
  });
}

module.exports = (config) => withSceneManifest(withSceneAppDelegate(config));
// For the tests (src/lib/__tests__/ios-scene-lifecycle.test.ts).
module.exports.internals = { moveStartToSceneDelegate, SCENE_MANIFEST };
