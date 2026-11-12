import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';
import { retroactiveSupport } from '../../lib/sieve/retroactive';
import type { FilterCondition } from '../../lib/sieve/types';
import { applyExistingUnsupportedReason } from '../filters/apply-existing-hint';

// The rule editor said subject rules can run on existing mail, while the
// switch stayed off for a subject rule that matches a regex.
describe('why a rule cannot run on existing messages', () => {
  const regexSubject = { field: 'subject', comparator: 'regex', value: '^Invoice [0-9]+$' } as FilterCondition;

  it('names the regular expression for a regex rule the switch refuses', () => {
    expect(retroactiveSupport({ conditions: [regexSubject], actions: [{ type: 'mark_read' }] }).ok).toBe(false);
    expect(applyExistingUnsupportedReason(false, [regexSubject])).toBe('regex');
    expect(translate('en', 'settings.filters.apply_existing_regex')).toMatch(/regular expression/);
  });

  it('keeps the period and the general hint for the other cases', () => {
    expect(applyExistingUnsupportedReason(true, [regexSubject])).toBe('period');
    expect(applyExistingUnsupportedReason(false, [{ comparator: 'contains' }])).toBe('other');
  });

  it('is the hint the rule editor shows', () => {
    const src = readFileSync(join(__dirname, '..', 'filters', 'FilterRuleModal.tsx'), 'utf8');
    expect(src).toMatch(/regex: t\('settings\.filters\.apply_existing_regex'/);
    expect(src).toContain('[applyExistingUnsupportedReason(periodOn, draft.conditions)]');
  });
});
