import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The Scheduled screen is a component the node test environment can't
// render; these check its wiring to the helpers tested elsewhere.
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ScheduledScreen.tsx'), 'utf8');
const body = (name: string) => {
  const start = source.indexOf(`const ${name} = `);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  };', start));
};

describe('Scheduled screen', () => {
  // A cancel that went through, with the move to Drafts failing after it,
  // read "Cancel failed" and left the row listed as scheduled.
  it('drops the row of a send cancelled but not moved to Drafts, and says so', () => {
    for (const name of ['onCancel', 'onEdit']) {
      const handler = body(name);
      expect(handler).toMatch(/\{ (inDrafts, )?moveError \} = await cancelScheduledToDrafts\(/);
      const handled = handler.slice(handler.indexOf('cancelScheduledToDrafts('), handler.indexOf('scheduled.cancelled_not_moved\''));
      expect(handled).toMatch(/removeItem\(item\);/);
      expect(handled).toMatch(/if \(moveError\) \{/);
    }
  });
});
