import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listSenderMatches, mergePersonSuggestions } from '../search-suggestions';

// Search suggestions named contacts only, so an account without contacts got
// none while typing (webmail lib/search-suggestions.ts, 4c5f3d8f2).

const mail = [
  { from: [{ name: 'Anna Berg', email: 'anna@shop.example' }] },
  { from: [{ name: 'Anna Berg', email: 'ANNA@shop.example' }] },
  { from: [{ name: 'Newsletter', email: 'news@annapolis.example' }] },
  { from: [{ name: 'Bob', email: 'bob@example.org' }] },
  { from: null },
];

describe('search suggestions', () => {
  it('suggests the senders of the loaded mail by name or address, each once', () => {
    expect(listSenderMatches(mail, 'anna')).toEqual([
      { name: 'Anna Berg', email: 'anna@shop.example' },
      { name: 'Newsletter', email: 'news@annapolis.example' },
    ]);
    expect(listSenderMatches(mail, '  ')).toEqual([]);
    expect(listSenderMatches(mail, 'anna', 1)).toHaveLength(1);
  });

  it('puts contacts first and drops a sender who is one of them', () => {
    const merged = mergePersonSuggestions(
      [{ name: 'Anna (contact)', email: 'Anna@shop.example' }],
      listSenderMatches(mail, 'anna'),
    );
    expect(merged).toEqual([
      { name: 'Anna (contact)', email: 'Anna@shop.example' },
      { name: 'Newsletter', email: 'news@annapolis.example' },
    ]);
  });

  it("is what the list's search field suggests", () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(src).toMatch(/return mergePersonSuggestions\(out, listSenderMatches\(useEmailStore\.getState\(\)\.emails, q\)\);/);
  });
});
