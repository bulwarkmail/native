import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Signed iOS releases and the inbox widget: release-ios.yml installs the
// widget's App Store profile, hands it to prebuild and names it in the export
// options only when IOS_WIDGET_PROVISIONING_PROFILE_BASE64 is set; without
// it the release builds as before, without the widget (plugins/ios-widget).
// The steps' shell scripts run here under bash with Apple's tools stubbed.

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/release-ios.yml'), 'utf8').replace(/\r\n/g, '\n');

interface Step { env: Record<string, string>; run: string }

/** A step of the build job by name: its env (unresolved) and its run script, dedented as Actions does. */
function step(name: string): Step {
  const lines = WORKFLOW.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`no step ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^      - |^  \S/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  const env: Record<string, string> = {};
  const envAt = body.indexOf('        env:');
  if (envAt >= 0) {
    for (const line of body.slice(envAt + 1)) {
      const m = /^ {10}([A-Z0-9_]+): (.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
      else if (!/^ {10}#/.test(line)) break;
    }
  }
  const runAt = body.indexOf('        run: |');
  let run = '';
  if (runAt >= 0) {
    run = body.slice(runAt + 1).filter((l, i, all) => l.startsWith('          ') || (l === '' && i < all.length - 1))
      .map((l) => l.slice(10)).join('\n');
  } else {
    const m = body.map((l) => /^ {8}run: (.*)$/.exec(l)).find(Boolean);
    if (m) run = m[1];
  }
  return { env, run };
}

/** Resolves `${{ secrets.X }}` and `${{ steps.profiles.outputs.X }}` as Actions does (missing = empty). */
function resolve(env: Record<string, string>, ctx: { secrets: Record<string, string>; outputs: Record<string, string> }) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{\{\s*(secrets|steps\.profiles\.outputs)\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, scope: string, key: string) =>
      (scope === 'secrets' ? ctx.secrets[key] : ctx.outputs[key]) ?? '');
  }
  return out;
}

// bash with coreutils: Linux CI, or Git Bash on Windows (not WSL's bash.exe).
const bash = spawnSync('bash', ['-c', 'uname -s'], { encoding: 'utf8' });
const haveBash = bash.status === 0 && (process.platform !== 'win32' || /MINGW|MSYS/.test(bash.stdout));

const STUBS = `
security() { cat "$4"; }                            # security cms -D -i FILE: the "decoded" plist
plutil() { sed -n "s/^$2=//p"; }                    # plutil -extract KEY raw -
xcodebuild() { :; }
`;

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-release-'));
  tmpDirs.push(dir);
  return dir.replace(/\\/g, '/');
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function runStep(script: string, env: Record<string, string>, cwd: string) {
  const res = spawnSync('bash', ['-e', '-c', STUBS + script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`step failed: ${res.stderr}`);
  return res.stdout;
}

function fakeProfile(uuid: string, name: string, bundleId: string): string {
  const plist = `UUID=${uuid}\nName=${name}\nEntitlements.application-identifier=TEAM123.${bundleId}\nExpirationDate=2027-08-01\n`;
  return Buffer.from(plist).toString('base64');
}

/** Runs the profile install, the prebuild env and the export plist of a signed release. */
function signedRelease(secrets: Record<string, string>) {
  const dir = tmp();
  const home = `${dir}/home`;
  const runnerTemp = `${dir}/runner`;
  fs.mkdirSync(home); fs.mkdirSync(`${runnerTemp}/export`, { recursive: true });
  fs.writeFileSync(`${runnerTemp}/export/Bulwark.ipa`, '');
  fs.writeFileSync(`${dir}/VERSION`, '1.2.3\n');
  const outputFile = `${dir}/github_output`;
  const base = { HOME: home, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: outputFile, GITHUB_SHA: 'abcdef1234567' };

  const install = step('Install the provisioning profiles');
  fs.writeFileSync(outputFile, '');
  const log = runStep(install.run, { ...base, ...resolve(install.env, { secrets, outputs: {} }) }, dir);
  const outputs = Object.fromEntries(fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  const prebuildEnv = resolve(step('Generate the iOS project').env, { secrets, outputs });

  const exp = step('Export the IPA');
  fs.writeFileSync(outputFile, '');
  runStep(exp.run, { ...base, ...resolve(exp.env, { secrets: { APPLE_TEAM_ID: 'TEAM123', ...secrets }, outputs }) }, dir);
  const exportOptions = fs.readFileSync(`${runnerTemp}/ExportOptions.plist`, 'utf8');
  const installed = fs.readdirSync(`${home}/Library/MobileDevice/Provisioning Profiles`).sort();
  return { log, outputs, prebuildEnv, exportOptions, installed };
}

const BASE_SECRETS = {
  IOS_PROVISIONING_PROFILE_BASE64: fakeProfile('app-uuid', 'Bulwark Mobile App Store', 'org.bulwarkmail.mobile'),
  IOS_NSE_PROVISIONING_PROFILE_BASE64: fakeProfile('nse-uuid', 'Bulwark NSE App Store', 'org.bulwarkmail.mobile.NotificationService'),
};
const WIDGET_SECRET = {
  IOS_WIDGET_PROVISIONING_PROFILE_BASE64: fakeProfile('widget-uuid', 'Bulwark Widget App Store', 'org.bulwarkmail.mobile.Widget'),
};

describe.skipIf(!haveBash)('signed iOS release and the widget profile', () => {
  it('builds as before without IOS_WIDGET_PROVISIONING_PROFILE_BASE64', () => {
    const r = signedRelease(BASE_SECRETS);
    expect(r.installed).toEqual(['app-uuid.mobileprovision', 'nse-uuid.mobileprovision']);
    expect(r.outputs.widget_uuid).toBeUndefined();
    expect(r.prebuildEnv).toMatchObject({ IOS_APP_PROFILE: 'app-uuid', IOS_NSE_PROFILE: 'nse-uuid', IOS_WIDGET_PROFILE: '' });
    expect(r.exportOptions).toContain('<key>org.bulwarkmail.mobile</key><string>Bulwark Mobile App Store</string>');
    expect(r.exportOptions).toContain('<key>org.bulwarkmail.mobile.NotificationService</key><string>Bulwark NSE App Store</string>');
    expect(r.exportOptions).not.toContain('Widget');
    expect(r.log).not.toContain('widget:');
  });

  it('installs the widget profile, hands it to prebuild and exports with it when the secret is set', () => {
    const r = signedRelease({ ...BASE_SECRETS, ...WIDGET_SECRET });
    expect(r.installed).toEqual(['app-uuid.mobileprovision', 'nse-uuid.mobileprovision', 'widget-uuid.mobileprovision']);
    expect(r.outputs).toMatchObject({ widget_uuid: 'widget-uuid', widget_bundle_id: 'org.bulwarkmail.mobile.Widget' });
    expect(r.prebuildEnv).toMatchObject({ IOS_APP_PROFILE: 'app-uuid', IOS_NSE_PROFILE: 'nse-uuid', IOS_WIDGET_PROFILE: 'widget-uuid' });
    const dict = /<key>provisioningProfiles<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(r.exportOptions)?.[1] ?? '';
    expect(dict).toContain('<key>org.bulwarkmail.mobile.Widget</key><string>Bulwark Widget App Store</string>');
    expect(dict).toContain('<key>org.bulwarkmail.mobile</key><string>Bulwark Mobile App Store</string>');
  });
});

describe('plugins/ios-widget in a signed build', () => {
  const plugin = createRequire(__filename)(path.join(ROOT, 'plugins/ios-widget/index.js')) as (config: object) => object;
  const saved = { app: process.env.IOS_APP_PROFILE, widget: process.env.IOS_WIDGET_PROFILE };
  afterEach(() => {
    for (const [k, v] of [['IOS_APP_PROFILE', saved.app], ['IOS_WIDGET_PROFILE', saved.widget]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });
  const config = () => ({ name: 'Bulwark', slug: 'bulwark', ios: { bundleIdentifier: 'org.bulwarkmail.mobile' } });

  it('leaves the widget out when prebuild gets an empty IOS_WIDGET_PROFILE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.IOS_APP_PROFILE = 'app-uuid';
    process.env.IOS_WIDGET_PROFILE = '';
    plugin(config());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('building without the widget'));
  });

  it('builds the widget when prebuild gets its profile', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.IOS_APP_PROFILE = 'app-uuid';
    process.env.IOS_WIDGET_PROFILE = 'widget-uuid';
    plugin(config());
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('building without the widget'));
  });
});
