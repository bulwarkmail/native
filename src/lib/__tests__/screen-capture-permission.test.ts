import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// expo-screen-capture calls Activity.registerScreenCaptureCallback on
// Android 14+ when its module loads. With DETECT_SCREEN_CAPTURE removed from
// the manifest that throws a SecurityException and the app crashed at launch.

const root = path.resolve(__dirname, '../../..');

describe('screen capture permission', () => {
  it('keeps DETECT_SCREEN_CAPTURE while expo-screen-capture is a dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies['expo-screen-capture']).toBeTruthy();
    const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/<uses-permission android:name="android\.permission\.DETECT_SCREEN_CAPTURE"\s*\/>/);
    expect(manifest).not.toMatch(/DETECT_SCREEN_CAPTURE"\s+tools:node="remove"/);
  });
});
