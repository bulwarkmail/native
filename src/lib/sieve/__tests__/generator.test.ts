import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import type { FilterRule } from '../types';

function makeRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'test@example.com' }],
    actions: [{ type: 'move', value: 'Archive' }],
    stopProcessing: false,
    ...overrides,
  };
}

describe('generateScript', () => {
  it('outputs metadata and no require for empty rules', () => {
    const script = generateScript([]);
    expect(script).toContain('/* @metadata:begin');
    expect(script).toContain('@metadata:end */');
    expect(script).not.toContain('require');
  });

  it('embeds compact metadata JSON', () => {
    const rules = [makeRule()];
    const script = generateScript(rules);
    const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
    expect(match).not.toBeNull();
    const metadata = JSON.parse(match![1]);
    expect(metadata.version).toBe(1);
    expect(metadata.rules).toHaveLength(1);
    expect(metadata.rules[0].id).toBe('rule-1');
  });

  it('generates single rule with from/contains', () => {
    const script = generateScript([makeRule()]);
    expect(script).toContain('# Rule: Test Rule');
    expect(script).toContain('if header :contains "From" "test@example.com"');
    expect(script).toContain('fileinto "Archive";');
  });

  describe('condition fields', () => {
    it('maps to field to "To" header', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'to', comparator: 'contains', value: 'me@x.com' }],
      })]);
      expect(script).toContain('header :contains "To" "me@x.com"');
    });

    it('maps cc field to "Cc" header', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'cc', comparator: 'is', value: 'cc@x.com' }],
      })]);
      expect(script).toContain('header :is "Cc" "cc@x.com"');
    });

    it('maps subject field to "Subject" header', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'subject', comparator: 'contains', value: 'hello' }],
      })]);
      expect(script).toContain('header :contains "Subject" "hello"');
    });

    it('maps header field with custom headerName', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'header', comparator: 'contains', value: 'test', headerName: 'X-Custom' }],
      })]);
      expect(script).toContain('header :contains "X-Custom" "test"');
    });

    it('handles size greater_than', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'size', comparator: 'greater_than', value: '1000000' }],
      })]);
      expect(script).toContain('size :over 1000000');
    });

    it('handles size less_than', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'size', comparator: 'less_than', value: '500' }],
      })]);
      expect(script).toContain('size :under 500');
    });

    it('handles body contains', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'body', comparator: 'contains', value: 'keyword' }],
      })]);
      expect(script).toContain('body :contains "keyword"');
      expect(script).toContain('"body"');
    });

    it('handles body is', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'body', comparator: 'is', value: 'exact' }],
      })]);
      expect(script).toContain('body :is "exact"');
    });
  });

  describe('comparators', () => {
    it('generates not_contains with not wrapper', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'from', comparator: 'not_contains', value: 'spam' }],
      })]);
      expect(script).toContain('not header :contains "From" "spam"');
    });

    it('generates not_is with not wrapper', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'from', comparator: 'not_is', value: 'bad@x.com' }],
      })]);
      expect(script).toContain('not header :is "From" "bad@x.com"');
    });

    it('generates starts_with as :matches with trailing *', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'subject', comparator: 'starts_with', value: 'Re:' }],
      })]);
      expect(script).toContain('header :matches "Subject" "Re:*"');
    });

    it('generates ends_with as :matches with leading *', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'subject', comparator: 'ends_with', value: 'urgent' }],
      })]);
      expect(script).toContain('header :matches "Subject" "*urgent"');
    });

    it('generates matches as :matches', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'from', comparator: 'matches', value: '*@company.com' }],
      })]);
      expect(script).toContain('header :matches "From" "*@company.com"');
    });
  });

  describe('match types', () => {
    it('wraps multiple conditions with allof for matchType all', () => {
      const script = generateScript([makeRule({
        matchType: 'all',
        conditions: [
          { field: 'from', comparator: 'contains', value: 'a' },
          { field: 'subject', comparator: 'contains', value: 'b' },
        ],
      })]);
      expect(script).toContain('allof(header :contains "From" "a", header :contains "Subject" "b")');
    });

    it('wraps multiple conditions with anyof for matchType any', () => {
      const script = generateScript([makeRule({
        matchType: 'any',
        conditions: [
          { field: 'from', comparator: 'contains', value: 'x' },
          { field: 'to', comparator: 'contains', value: 'y' },
        ],
      })]);
      expect(script).toContain('anyof(header :contains "From" "x", header :contains "To" "y")');
    });

    it('uses no wrapper for single condition', () => {
      const script = generateScript([makeRule()]);
      expect(script).not.toContain('allof');
      expect(script).not.toContain('anyof');
    });
  });

  describe('actions', () => {
    it('generates move as fileinto', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'move', value: 'Spam' }] })]);
      expect(script).toContain('fileinto "Spam";');
    });

    it('generates copy as fileinto :copy', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'copy', value: 'Backup' }] })]);
      expect(script).toContain('fileinto :copy "Backup";');
    });

    it('generates forward as redirect', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'forward', value: 'fwd@x.com' }] })]);
      expect(script).toContain('redirect "fwd@x.com";');
    });

    it('generates mark_read as addflag \\Seen', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'mark_read' }] })]);
      expect(script).toContain('addflag "\\\\Seen";');
    });

    it('generates star as addflag \\Flagged', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'star' }] })]);
      expect(script).toContain('addflag "\\\\Flagged";');
    });

    it('generates add_label as addflag $label:Label', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'add_label', value: 'Important' }] })]);
      expect(script).toContain('addflag "$label:Important";');
    });

    it('generates discard', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'discard' }] })]);
      expect(script).toContain('discard;');
    });

    it('generates reject with message', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'reject', value: 'Go away' }] })]);
      expect(script).toContain('reject "Go away";');
    });

    it('generates keep', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'keep' }] })]);
      expect(script).toContain('keep;');
    });

    it('generates stop', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'stop' }] })]);
      expect(script).toContain('stop;');
    });
  });

  describe('stopProcessing', () => {
    it('appends stop when stopProcessing is true', () => {
      const script = generateScript([makeRule({ stopProcessing: true })]);
      const ifBlock = script.slice(script.indexOf('if '));
      expect(ifBlock).toContain('stop;');
    });

    it('does not duplicate stop if last action is stop', () => {
      const script = generateScript([makeRule({
        actions: [{ type: 'move', value: 'X' }, { type: 'stop' }],
        stopProcessing: true,
      })]);
      const matches = script.match(/stop;/g);
      expect(matches).toHaveLength(1);
    });

    it('does not append stop after discard', () => {
      const script = generateScript([makeRule({
        actions: [{ type: 'discard' }],
        stopProcessing: true,
      })]);
      const matches = script.match(/stop;/g);
      expect(matches).toBeNull();
    });

    it('does not append stop after reject', () => {
      const script = generateScript([makeRule({
        actions: [{ type: 'reject', value: 'No' }],
        stopProcessing: true,
      })]);
      const matches = script.match(/stop;/g);
      expect(matches).toBeNull();
    });
  });

  describe('disabled rules', () => {
    it('excludes disabled rules from Sieve code', () => {
      const script = generateScript([makeRule({ enabled: false, name: 'Hidden' })]);
      expect(script).not.toContain('# Rule: Hidden');
      expect(script).not.toContain('if header');
    });

    it('preserves disabled rules in metadata', () => {
      const rules = [makeRule({ enabled: false })];
      const script = generateScript(rules);
      const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
      const metadata = JSON.parse(match![1]);
      expect(metadata.rules[0].enabled).toBe(false);
    });

    it('handles mixed enabled and disabled rules', () => {
      const rules = [
        makeRule({ id: '1', name: 'Active', enabled: true }),
        makeRule({ id: '2', name: 'Inactive', enabled: false }),
        makeRule({ id: '3', name: 'Also Active', enabled: true }),
      ];
      const script = generateScript(rules);
      expect(script).toContain('# Rule: Active');
      expect(script).not.toContain('# Rule: Inactive');
      expect(script).toContain('# Rule: Also Active');
    });
  });

  describe('require extensions', () => {
    it('includes fileinto for move', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'move', value: 'X' }] })]);
      expect(script).toContain('"fileinto"');
    });

    it('includes fileinto and copy for copy action', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'copy', value: 'X' }] })]);
      expect(script).toContain('"copy"');
      expect(script).toContain('"fileinto"');
    });

    it('includes imap4flags for mark_read', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'mark_read' }] })]);
      expect(script).toContain('"imap4flags"');
    });

    it('includes imap4flags for star', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'star' }] })]);
      expect(script).toContain('"imap4flags"');
    });

    it('includes imap4flags for add_label', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'add_label', value: 'X' }] })]);
      expect(script).toContain('"imap4flags"');
    });

    it('includes reject for reject action', () => {
      const script = generateScript([makeRule({ actions: [{ type: 'reject', value: 'No' }] })]);
      expect(script).toContain('"reject"');
    });

    it('includes body extension for body conditions', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'body', comparator: 'contains', value: 'test' }],
      })]);
      expect(script).toContain('"body"');
    });

    it('deduplicates extensions', () => {
      const script = generateScript([
        makeRule({ id: '1', actions: [{ type: 'star' }] }),
        makeRule({ id: '2', actions: [{ type: 'mark_read' }] }),
      ]);
      const matches = script.match(/"imap4flags"/g);
      expect(matches).toHaveLength(1);
    });

    it('only considers enabled rules for requires', () => {
      const script = generateScript([
        makeRule({ id: '1', enabled: false, actions: [{ type: 'reject', value: 'X' }] }),
        makeRule({ id: '2', enabled: true, actions: [{ type: 'move', value: 'Y' }] }),
      ]);
      const requireLine = script.split('\n').find(l => l.startsWith('require'));
      expect(requireLine).not.toContain('reject');
      expect(requireLine).toContain('fileinto');
    });
  });

  describe('escaping', () => {
    it('escapes double quotes in values', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'subject', comparator: 'contains', value: 'say "hello"' }],
      })]);
      expect(script).toContain('say \\"hello\\"');
    });

    it('escapes backslashes in values', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'subject', comparator: 'contains', value: 'path\\to\\file' }],
      })]);
      expect(script).toContain('path\\\\to\\\\file');
    });

    it('escapes folder names in actions', () => {
      const script = generateScript([makeRule({
        actions: [{ type: 'move', value: 'My "Folder"' }],
      })]);
      expect(script).toContain('fileinto "My \\"Folder\\"";');
    });
  });

  describe('round-trip', () => {
    it('preserves rules through generate â†’ parse cycle', () => {
      const rules: FilterRule[] = [
        makeRule({ id: '1', name: 'Rule A', enabled: true }),
        makeRule({ id: '2', name: 'Rule B', enabled: false }),
        makeRule({
          id: '3',
          name: 'Complex',
          matchType: 'any',
          conditions: [
            { field: 'from', comparator: 'contains', value: 'boss' },
            { field: 'subject', comparator: 'starts_with', value: 'URGENT' },
          ],
          actions: [{ type: 'star' }, { type: 'mark_read' }],
          stopProcessing: true,
        }),
      ];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.isOpaque).toBe(false);
      expect(result.rules).toEqual(rules);
    });
  });

  it('generates multiple rules in order', () => {
    const rules = [
      makeRule({ id: '1', name: 'First', actions: [{ type: 'move', value: 'A' }] }),
      makeRule({ id: '2', name: 'Second', actions: [{ type: 'move', value: 'B' }] }),
    ];
    const script = generateScript(rules);
    const firstIdx = script.indexOf('# Rule: First');
    const secondIdx = script.indexOf('# Rule: Second');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  describe('edge cases', () => {
    it('skips rules with empty conditions', () => {
      const script = generateScript([makeRule({ name: 'Empty', conditions: [], actions: [{ type: 'keep' }] })]);
      expect(script).not.toContain('# Rule: Empty');
      expect(script).not.toContain('if ');
    });

    it('skips rules with empty actions', () => {
      const script = generateScript([makeRule({ name: 'NoAction', actions: [] })]);
      expect(script).not.toContain('# Rule: NoAction');
      expect(script).not.toContain('if ');
    });

    it('uses X-Unknown for header field without headerName', () => {
      const script = generateScript([makeRule({
        conditions: [{ field: 'header', comparator: 'contains', value: 'test' }],
      })]);
      expect(script).toContain('header :contains "X-Unknown" "test"');
    });

    it('handles all enabled rules with different extensions combined', () => {
      const rules = [
        makeRule({ id: '1', actions: [{ type: 'move', value: 'A' }] }),
        makeRule({ id: '2', actions: [{ type: 'reject', value: 'No' }] }),
        makeRule({ id: '3', conditions: [{ field: 'body', comparator: 'contains', value: 'x' }], actions: [{ type: 'star' }] }),
      ];
      const script = generateScript(rules);
      const requireLine = script.split('\n').find(l => l.startsWith('require'))!;
      expect(requireLine).toContain('"fileinto"');
      expect(requireLine).toContain('"reject"');
      expect(requireLine).toContain('"body"');
      expect(requireLine).toContain('"imap4flags"');
    });

    it('generates no require line when only keep/discard/stop/forward actions', () => {
      const script = generateScript([makeRule({
        actions: [{ type: 'keep' }, { type: 'forward', value: 'a@b.com' }],
      })]);
      expect(script).not.toContain('require');
    });

    it('handles multiple actions on same rule', () => {
      const script = generateScript([makeRule({
        actions: [
          { type: 'move', value: 'Folder' },
          { type: 'mark_read' },
          { type: 'star' },
          { type: 'stop' },
        ],
      })]);
      expect(script).toContain('fileinto "Folder";');
      expect(script).toContain('addflag "\\\\Seen";');
      expect(script).toContain('addflag "\\\\Flagged";');
      expect(script).toContain('stop;');
    });

    it('generates valid script for all-disabled rules', () => {
      const rules = [
        makeRule({ id: '1', enabled: false }),
        makeRule({ id: '2', enabled: false }),
      ];
      const script = generateScript(rules);
      expect(script).toContain('@metadata:begin');
      expect(script).not.toContain('if ');
      expect(script).not.toContain('require');
    });
  });
});
