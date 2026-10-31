import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateScript } from '../generator';
import { isValidVacationForward, vacationForwardAddress } from '../vacation-forward';

// A forward address with a Unicode domain went into the Sieve redirect as
// typed; the server needs the ASCII (xn--) form (bulwarkmail/webmail#1100).

describe('vacation forwarding to a Unicode domain', () => {
  it('writes the redirect with the domain in ASCII form', () => {
    const to = vacationForwardAddress('  Ich@bücher.de ');
    expect(to).toBe('Ich@xn--bcher-kva.de');
    const forward = { enabled: true, to, keepCopy: false };
    expect(isValidVacationForward(forward)).toBe(true);
    const script = generateScript([], undefined, { includeVacation: true, vacationForward: forward });
    expect(script).toContain('redirect "Ich@xn--bcher-kva.de";');
    expect(script).not.toContain('bücher');
    // ASCII addresses stay as they are.
    expect(vacationForwardAddress('a@example.org')).toBe('a@example.org');
  });

  // No RN renderer in the test env: check the settings page's wiring.
  it('is what the out-of-office page checks and saves', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../components/settings/VacationSettings.tsx'), 'utf8');
    expect(page).toMatch(/const forwardAddress = vacationForwardAddress\(forwardTo\);/);
    expect(page).toMatch(/\{ enabled: forwardEnabled, to: forwardAddress, keepCopy: forwardKeep \}/);
  });
});
