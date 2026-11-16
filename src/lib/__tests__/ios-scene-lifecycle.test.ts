import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

// Built with the iOS 27 SDK the app must start through a scene delegate
// (plugins/ios-scene-lifecycle.js, #145). The plugin edits the AppDelegate
// that `expo prebuild` generates; these run that edit on a copy of it.

const ROOT = path.resolve(__dirname, '../../..');
const { internals } = createRequire(__filename)(path.join(ROOT, 'plugins/ios-scene-lifecycle.js')) as {
  internals: {
    moveStartToSceneDelegate(contents: string): string;
    SCENE_MANIFEST: {
      UIApplicationSupportsMultipleScenes: boolean;
      UISceneConfigurations: Record<string, { UISceneDelegateClassName: string }[]>;
    };
  };
};

// Expo SDK 54's AppDelegate.swift, shortened.
const APP_DELEGATE = [
  'public class AppDelegate: ExpoAppDelegate {',
  '  var window: UIWindow?',
  '',
  '  var reactNativeFactory: RCTReactNativeFactory?',
  '',
  '  public override func application(',
  '    _ application: UIApplication,',
  '    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil',
  '  ) -> Bool {',
  '    bindReactNativeFactory(factory)',
  '',
  '#if os(iOS) || os(tvOS)',
  '    window = UIWindow(frame: UIScreen.main.bounds)',
  '    factory.startReactNative(',
  '      withModuleName: "main",',
  '      in: window,',
  '      launchOptions: launchOptions)',
  '#endif',
  '',
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  '  }',
  '}',
  '',
].join('\n');

describe('the scene life cycle plugin', () => {
  it("moves the window and React Native's start out of didFinishLaunching", () => {
    const out = internals.moveStartToSceneDelegate(APP_DELEGATE);
    const appDelegate = out.slice(0, out.indexOf('class SceneDelegate'));
    expect(appDelegate).not.toContain('UIWindow(frame:');
    expect(appDelegate).not.toContain('startReactNative');
    // The scene delegate starts React Native with the options the app was launched with.
    expect(appDelegate).toContain('  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n');
    const kept = appDelegate.indexOf('    self.launchOptions = launchOptions\n');
    expect(kept).toBeGreaterThan(appDelegate.indexOf('bindReactNativeFactory'));
    expect(kept).toBeLessThan(appDelegate.indexOf('return super.application('));
  });

  it('starts React Native in a window made for the scene', () => {
    const out = internals.moveStartToSceneDelegate(APP_DELEGATE);
    const scene = out.slice(out.indexOf('class SceneDelegate'));
    expect(scene).toContain('UIWindow(windowScene: windowScene)');
    expect(scene).toContain('appDelegate.window = window');
    expect(scene).toMatch(/factory\.startReactNative\(\s*withModuleName: "main",\s*in: window,\s*launchOptions: launchOptions\)/);
    // A link that starts the app arrives in the connection options; it goes
    // into the launch options, where Linking.getInitialURL() reads it.
    expect(scene).toContain('var launchOptions = appDelegate.launchOptions ?? [:]');
    expect(scene).toContain('launchOptions[.url] = url');
    expect(scene).toContain('open(connectionOptions.urlContexts)');
    expect(scene).toContain('for activity in connectionOptions.userActivities');
  });

  it('changes nothing on a second prebuild', () => {
    const out = internals.moveStartToSceneDelegate(APP_DELEGATE);
    expect(internals.moveStartToSceneDelegate(out)).toBe(out);
  });

  it('fails the prebuild when a line it moves is missing', () => {
    const without = (line: RegExp) => APP_DELEGATE.replace(line, '');
    expect(() => internals.moveStartToSceneDelegate(without(/^ *window = UIWindow.*\n/m))).toThrow(/window creation/);
    expect(() => internals.moveStartToSceneDelegate(without(/^ *factory\.startReactNative\([\s\S]*?launchOptions\)\n/m))).toThrow(/startReactNative/);
    expect(() => internals.moveStartToSceneDelegate(without(/^ {2}var window: UIWindow\?\n/m))).toThrow(/window property/);
  });

  it("names the scene delegate in the manifest and keeps the app to one scene", () => {
    expect(internals.SCENE_MANIFEST.UIApplicationSupportsMultipleScenes).toBe(false);
    const [config] = internals.SCENE_MANIFEST.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
    expect(config.UISceneDelegateClassName).toBe('$(PRODUCT_MODULE_NAME).SceneDelegate');
  });
});
