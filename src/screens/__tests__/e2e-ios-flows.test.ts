import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The iOS e2e flows (.maestro) and their runner (scripts/e2e/run-flows.sh).
// They only run on a macOS simulator in CI; this checks the parts that went
// wrong there.

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('run-flows.sh: one more try when the Maestro driver failed', () => {
  const script = read('scripts/e2e/run-flows.sh');
  const pattern = /^DRIVER_DIED='([^']+)'$/m.exec(script)?.[1] ?? '';
  const driverDied = new RegExp(pattern);

  it('retries a flow whose driver died or never started', () => {
    expect(pattern).not.toBe('');
    // Maestro's own lines, from runs 41220976434 and earlier.
    for (const line of [
      'xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time, consider increasing timeout by configuring MAESTRO_DRIVER_STARTUP_TIMEOUT env variable',
      'iOS driver not ready in time, consider increasing timeout',
      'maestro.DeviceUnreachableException: Device became unreachable',
      'Transport unreachable',
    ]) expect(line).toMatch(driverDied);
  });

  it('does not retry a flow that failed on the app', () => {
    for (const line of [
      'Assertion is false: "The account is removed from this device.*" is visible',
      'Element not found: Text matching regex: Sign out',
    ]) expect(line).not.toMatch(driverDied);
  });

  it('greps the flow\'s debug output for it, and tries at most twice', () => {
    expect(script).toContain('grep -rqE "$DRIVER_DIED" "$DEBUG_DIR/$name$suffix" 2>/dev/null || break');
    expect(script).toMatch(/for attempt in 1 2; do\n\s+suffix=""/);
    expect(script).toContain('[ $attempt -eq 2 ] && break');
  });
});

describe('15-email-discovery types through type.yaml', () => {
  const flow = read('.maestro/signin/15-email-discovery.yaml');

  it('types the address with the checked subflow, not a bare inputText', () => {
    expect(flow).not.toMatch(/^- inputText:/m);
    expect(flow).toMatch(/- runFlow:\n {4}file: \.\.\/subflows\/type\.yaml\n {4}env:\n {6}FIELD: login-email-input\n {6}TAP: "no"\n {6}TEXT: \$\{ACCOUNT\}@example\.org\n/);
  });

  it('names a field the email step has', () => {
    expect(read('src/screens/login/EmailStep.tsx')).toContain('testID="login-email-input"');
  });
});

describe('sign-out.yaml survives a keyboard over "Sign out"', () => {
  const flow = read('.maestro/subflows/sign-out.yaml');
  const retry = /- retry:\n {4}maxRetries: 1\n {4}commands:\n([\s\S]*?)(?=\n# |\n- |$)/.exec(flow)?.[1] ?? '';

  it('taps "Sign out" and waits for the dialog inside one retry', () => {
    expect(retry).toMatch(/- tapOn: "Sign out"\n {6}- extendedWaitUntil:\n {10}visible: "The account is removed from this device\.\*"/);
  });

  it('closes the keyboard and empties the settings search before the tap', () => {
    const tap = retry.indexOf('- tapOn: "Sign out"');
    const before = retry.slice(0, tap);
    expect(before).toMatch(/when:\n\s+visible: "Clear search"\n\s+commands:\n\s+- tapOn: "Clear search"/);
    // The keyboard is checked before and after the scroll.
    const hides = [...before.matchAll(/visible:\n\s+id: delete\n\s+commands:\n\s+- hideKeyboard/g)];
    expect(hides).toHaveLength(2);
    expect(before.lastIndexOf('hideKeyboard')).toBeGreaterThan(before.indexOf('scrollUntilVisible'));
  });
});
