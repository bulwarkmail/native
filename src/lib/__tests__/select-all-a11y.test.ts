import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { selectAllA11y } from '../select-all-a11y';

// Trash's Select all checkbox was announced "mixed" with nothing selected:
// Android kept the "mixed" a string state had written into the description
// after the state went back to false. The checkbox now never uses 'mixed'.

const t = (_key: string, fallback: string, values?: Record<string, string | number>) =>
  fallback.replace('{count, plural, one {1 email} other {# emails}}', `${values?.count} emails`);
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('Select all checkbox for screen readers', () => {
  it('is plain unchecked with nothing selected', () => {
    expect(selectAllA11y(false, 0, t)).toEqual({ label: 'Select all', checked: false });
  });

  it('names the count in the label while some rows are selected', () => {
    expect(selectAllA11y(false, 3, t)).toEqual({ label: 'Select all, 3 emails selected', checked: false });
  });

  it('is checked with every row selected', () => {
    expect(selectAllA11y(true, 5, t)).toEqual({ label: 'Select all', checked: true });
  });

  it('never hands the list checkbox a mixed state', () => {
    const list = read('screens/EmailListScreen.tsx');
    expect(list).not.toMatch(/'mixed'/);
    expect(list).toMatch(/accessibilityLabel=\{selectAll\.label\}\s+accessibilityState=\{\{ checked: selectAll\.checked \}\}/);
  });
});
