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

  // The list loaded once, on mount: after a deep-link switch of logins it
  // still showed the first login's rows, and Cancel or Send now acted on the
  // new login's submissions with the same ids.
  it('remembers the login the rows were read for and acts on them only while it is active', () => {
    const load = source.slice(source.indexOf('const load = React.useCallback('));
    expect(load).toMatch(/^const load = React\.useCallback\(async \(\) => \{[\s\S]*?const owner = servedLoginOf\(jmapClient\);[\s\S]*?await listScheduledEmails\(\);[\s\S]*?if \(loginMovedFrom\(owner\)\) return;\s+ownerRef\.current = owner;\s+setItems\(list\);/);
    expect(body('runAction')).toMatch(/^const runAction = async [^\n]*\{\s+if \(refuseOtherLogin\(\)\) return;/);
    expect(source).toMatch(/const openView = React\.useCallback\(\(item: ScheduledEmail\) => \{\s+if \(refuseOtherLogin\(\)\) return;/);
    expect(source).toMatch(/if \(!loginMovedFrom\(ownerRef\.current\)\) return false;/);
  });

  it('reads the list again for every session and drops the rows of another login', () => {
    expect(source).toMatch(/if \(ownerRef\.current !== null && loginMovedFrom\(ownerRef\.current\)\) \{[\s\S]*?setItems\(\[\]\);[\s\S]*?void load\(\);\s+\}, \[activeAccountId, session, load\]\);/);
  });

  it('closes the view of a message that is no longer listed', () => {
    expect(source).toMatch(/if \(viewing && !items\.some\(\(i\) => sameScheduledSend\(i, viewing\)\)\) closeView\(\);\s+\}, \[items, viewing, closeView\]\);/);
  });
});
