import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlankReply, vacationMessageBlocksSave, vacationMessageEmpty } from '../vacation-message';

// Webmail 1.21: an empty out-of-office message never goes live, and a reply
// with nothing written yet starts with real text.
describe('the out-of-office message', () => {
  it('counts a reply that is off with no subject and no text as blank', () => {
    expect(isBlankReply({ isEnabled: false, subject: '', textBody: ' ', htmlBody: '<p> </p>' })).toBe(true);
    expect(isBlankReply({ isEnabled: false, subject: '', textBody: '', htmlBody: '<p>Away</p>' })).toBe(false);
    expect(isBlankReply({ isEnabled: true, subject: '', textBody: '' })).toBe(false);
  });

  it('blocks a save of a reply that is on with an empty message', () => {
    expect(vacationMessageBlocksSave(true, '  ', false, '')).toBe(true);
    expect(vacationMessageBlocksSave(true, '', true, '<p><br></p>')).toBe(true);
    expect(vacationMessageBlocksSave(true, '', true, '<p>Back Monday</p>')).toBe(false);
    expect(vacationMessageBlocksSave(false, '', false, '')).toBe(false);
    expect(vacationMessageEmpty('Back Monday', false, '')).toBe(false);
  });

  // No render setup in the repo: the settings page is checked for using them.
  it('is what the settings page seeds, switches and saves by', () => {
    const page = readFileSync(join(__dirname, '../../components/settings/VacationSettings.tsx'), 'utf-8');
    expect(page).toMatch(/isBlankReply\(s\)/);
    expect(page).toMatch(/&& !vacationMessageBlocksSave\(enabled, body, htmlEnabled, htmlBody\)/);
    expect(page).toMatch(/if \(on && messageEmpty\) \{\r?\n\s+setNeedMessage\(true\);/);
    expect(page).not.toMatch(/settings\.vacation\.message\.body_placeholder/);
  });
});
