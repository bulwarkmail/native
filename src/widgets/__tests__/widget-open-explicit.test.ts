import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, links } from '../clicks';

const root = path.resolve(__dirname, '../../..');
const patchFile = path.join(root, 'patches/react-native-android-widget+0.22.1.patch');
const provider = 'node_modules/react-native-android-widget/android/src/main/java/com/reactnativeandroidwidget/RNWidgetProvider.java';

// The library's own openUri, as published: what the patch is applied to.
const UPSTREAM_OPEN_URI = [
  '    private void openUri(Context context, String uri) {',
  '        try {',
  '            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));',
  '            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);',
  '            context.startActivity(intent);',
  '        } catch (Exception e) {',
  '            e.printStackTrace();',
  '        }',
  '    }',
];

describe('a tap that opens the app from a widget', () => {
  it('goes through the library’s OPEN_URI, which the patch makes explicit', () => {
    expect(open(links.inbox())).toEqual({ clickAction: 'OPEN_URI', clickActionData: { uri: 'bulwarkmobile://mail/folder/inbox' } });
  });

  it('is sent to this app’s own package, so no chooser offers another build', async () => {
    const { parsePatchFile } = await import(path.join(root, 'node_modules/patch-package/dist/patch/parse.js'));
    const { executeEffects } = await import(path.join(root, 'node_modules/patch-package/dist/patch/apply.js'));
    const effects = parsePatchFile(fs.readFileSync(patchFile, 'utf8'))
      .filter((e: { path?: string }) => e.path?.endsWith('RNWidgetProvider.java'));
    expect(effects).toHaveLength(1);

    // The published file around openUri, padded to its line numbers.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-patch-'));
    const target = path.join(dir, provider);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const lines = Array.from({ length: 131 }, () => '').concat(UPSTREAM_OPEN_URI, ['', '}']);
    fs.writeFileSync(target, lines.join('\n'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      executeEffects(effects, { dryRun: false });
    } finally {
      process.chdir(cwd);
    }
    const patched = fs.readFileSync(target, 'utf8');
    const openUri = patched.slice(patched.indexOf('private void openUri'), patched.indexOf('startActivity'));
    expect(openUri).toMatch(/intent\.setPackage\(context\.getPackageName\(\)\);/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
