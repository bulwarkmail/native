import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #85: a notification's Delete asked to unlock the phone even where it only
// moves the mail to Trash. The push task tells the native module
// (deleteNeedsUnlock: !hasTrash); the module has to use it on the action.

const MODULE = path.resolve(
  __dirname,
  '../../../android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkFcmModule.kt',
);
const source = fs.readFileSync(MODULE, 'utf8');

function postNotificationCalls(src: string): string[] {
  const out: string[] = [];
  const re = /(?<!fun )\bpostNotification\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + 'postNotification'.length;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('notification Delete action', () => {
  it('reads deleteNeedsUnlock and keeps unlock as the default', () => {
    expect(source).toMatch(
      /val deleteNeedsUnlock = !options\.hasKey\("deleteNeedsUnlock"\) \|\| options\.getBoolean\("deleteNeedsUnlock"\)/,
    );
  });

  it('asks to unlock only when told to', () => {
    expect(source).toMatch(/\.setAuthenticationRequired\(deleteNeedsUnlock\)/);
    expect(source).not.toMatch(/\.setAuthenticationRequired\(true\)/);
    expect(source).toMatch(/private fun postNotification\([^)]*deleteNeedsUnlock: Boolean/);
  });

  it('passes it on every postNotification call', () => {
    const calls = postNotificationCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/\bdeleteNeedsUnlock\b/);
  });
});
