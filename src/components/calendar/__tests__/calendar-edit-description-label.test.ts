import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const source = fs.readFileSync(path.resolve(__dirname, '../CalendarEditSheet.tsx'), 'utf8');
const catalog = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const common = catalog('locales/en/common.json');
const overlay = catalog('locales/rn/en.json');

function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
}

// The app reads the overlay over the webmail's catalog.
const english = (key: string) => (lookup(overlay, key) ?? lookup(common, key)) as string | undefined;

describe('the calendar sheet’s description field', () => {
  it('is named "Description", not by the webmail’s desktop help text', () => {
    const before = source.slice(0, source.indexOf('value={description}'));
    const input = before.slice(before.lastIndexOf('<TextInput'));
    const key = input.match(/accessibilityLabel=\{t\('([^']+)'/)?.[1];
    expect(key).toBeTruthy();
    expect(english(key!)).toBe('Description');

    const labels = [...before.matchAll(/<Text style=\{styles\.label\}>\{t\('([^']+)'/g)];
    expect(english(labels[labels.length - 1][1])).toBe('Description');
  });
});
