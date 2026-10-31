import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The iOS config plugins (plugins/ios-push, ios-client-cert, ios-widget) run
// over Expo's SDK 54 template the way `expo prebuild --platform ios` does,
// and the Xcode project they leave must be one CocoaPods can save: pod
// install failed with "Consistency issue: no parent for object
// SharedKeychain.swift" when the notification extension and the widget
// shared one file reference and one build file for their copies of it.

const ROOT = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(ROOT, 'package.json'));
const { compileModsAsync, withPlugins } = req('@expo/config-plugins');

type Check = { problems: string[]; sources: Record<string, string[]> };
type Checker = { checkXcodeProject: (pbxproj: string) => Check };
const PROJECT = 'BulwarkMobile';

/** Unpacks the files under package/ios/ of Expo's template tarball into dir/ios. */
function unpackTemplateIos(dir: string) {
  const tgz = path.join(path.dirname(req.resolve('expo/package.json')), 'template.tgz');
  const tar = zlib.gunzipSync(fs.readFileSync(tgz));
  const text = (start: number, length: number) => tar.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = text(offset, 100);
    if (!name) break;
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1);
    const full = [text(offset + 345, 155), name].filter(Boolean).join('/');
    const body = offset + 512;
    if ((type === '0' || type === '') && full.startsWith('package/ios/')) {
      const out = path.join(dir, full.slice('package/'.length));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, tar.subarray(body, body + size));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
}

/** Renames the template's HelloWorld project the way expo prebuild does. */
function renameTemplate(dir: string) {
  const walk = (p: string) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      let full = path.join(p, entry.name);
      if (entry.name.includes('HelloWorld')) {
        const renamed = path.join(p, entry.name.replace(/HelloWorld/g, PROJECT));
        fs.renameSync(full, renamed);
        full = renamed;
      }
      if (entry.isDirectory()) walk(full);
      else if (!full.endsWith('.png')) {
        const body = fs.readFileSync(full, 'utf8');
        fs.writeFileSync(full, body.replace(/HelloWorld/g, PROJECT).replace(/helloworld/g, PROJECT.toLowerCase()));
      }
    }
  };
  walk(path.join(dir, 'ios'));
}

/** The app's config with only the plugins that change the Xcode project. */
function appConfig(projectRoot: string) {
  const config = {
    _internal: { projectRoot },
    name: 'Bulwark Mobile',
    slug: 'bulwark-mobile',
    version: '1.0.0',
    ios: { bundleIdentifier: 'org.bulwarkmail.mobile', buildNumber: '1' },
  };
  return withPlugins(config, [
    [req('./plugins/ios-push'), { apsEnvironment: 'production', teamId: 'TEAMID' }],
    req('./plugins/ios-client-cert'),
    [req('./plugins/ios-widget'), { teamId: 'TEAMID' }],
  ]);
}

const prebuild = (projectRoot: string) =>
  compileModsAsync(appConfig(projectRoot), { projectRoot, platforms: ['ios'], assertMissingModProviders: false });

describe('the Xcode project after the iOS config plugins', () => {
  let dir = '';
  let pbxproj = '';
  let checker: Checker;
  let first: Check;
  const env = { ...process.env };

  beforeAll(async () => {
    // The release workflow's signing variables would leave the widget out.
    for (const key of ['APS_ENVIRONMENT', 'APPLE_TEAM_ID', 'IOS_APP_PROFILE', 'IOS_NSE_PROFILE', 'IOS_WIDGET_PROFILE']) {
      delete process.env[key];
    }
    checker = (await import(pathToFileURL(path.join(ROOT, 'scripts/check-xcode-project.mjs')).href)) as Checker;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulwark-ios-prebuild-'));
    unpackTemplateIos(dir);
    renameTemplate(dir);
    pbxproj = path.join(dir, 'ios', `${PROJECT}.xcodeproj`, 'project.pbxproj');
    await prebuild(dir);
    first = checker.checkXcodeProject(pbxproj);
  }, 120_000);

  afterAll(() => {
    process.env = env;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives every compiled file a build file of its own in a group of its own', () => {
    expect(first.problems).toEqual([]);
  });

  it('compiles each target\'s own copy of the shared sources', () => {
    const { sources } = first;
    expect(sources[PROJECT]).toEqual(
      expect.arrayContaining(['SharedKeychain.swift', 'Jmap.swift', 'PushRenewal.swift', 'PushRenewalTask.swift'].map((f) => `${PROJECT}/${f}`)),
    );
    expect([...sources.NotificationService].sort()).toEqual(
      ['Jmap.swift', 'NotificationService.swift', 'PushRenewal.swift', 'SharedKeychain.swift'].map((f) => `NotificationService/${f}`),
    );
    expect([...sources.BulwarkWidget].sort()).toEqual(['BulwarkWidget/BulwarkWidget.swift', 'BulwarkWidget/SharedKeychain.swift']);
    // Every copy sits where the plugins put the file.
    for (const files of Object.values(sources)) {
      for (const file of files) expect(fs.existsSync(path.join(dir, 'ios', file)), file).toBe(true);
    }
  });

  it('leaves the project as it was when prebuild runs again without --clean', async () => {
    const before = fs.readFileSync(pbxproj, 'utf8');
    await prebuild(dir);
    const again = checker.checkXcodeProject(pbxproj);
    expect(again.problems).toEqual([]);
    expect(again.sources).toEqual(first.sources);
    expect(fs.readFileSync(pbxproj, 'utf8')).toBe(before);
  }, 120_000);
});
