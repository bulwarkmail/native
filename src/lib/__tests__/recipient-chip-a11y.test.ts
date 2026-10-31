// The cross on a composer recipient chip said only "Remove".
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';
import { recipientRemoveAccessibilityLabel } from '../recipient-chip-a11y';

const t = (key: string, fallback?: string, params?: Record<string, string | number>) =>
  translate('en', key, fallback ?? key, params);

describe('recipient chip remove label', () => {
  it('names the recipient', () => {
    expect(recipientRemoveAccessibilityLabel({ name: 'Anna Berg', email: 'anna@example.org' }, t)).toBe('Remove Anna Berg');
  });

  it('falls back to the address when the chip has no name', () => {
    expect(recipientRemoveAccessibilityLabel({ name: '  ', email: 'anna@example.org' }, t)).toBe('Remove anna@example.org');
  });

  it('is what the chip cross uses', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../components/compose/RecipientSuggestionList.tsx'), 'utf8');
    expect(source).toMatch(/accessibilityLabel=\{recipientRemoveAccessibilityLabel\(/);
  });
});
