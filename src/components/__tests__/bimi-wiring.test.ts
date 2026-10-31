import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// BIMI sender logos (webmail components/ui/avatar.tsx brandDomain, used by
// email-list-item, thread-list-item, email-viewer and thread-conversation-view).
// No React Native renderer in the test env, so this checks that every avatar
// of a received message hands SenderAvatar its brand domain; the helper has
// unit tests in lib/__tests__/avatar-bimi.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('BIMI logo wiring', () => {
  it('gives list rows the brand domain, none on rows that show the recipient', () => {
    const src = read('screens/EmailListScreen.tsx');
    expect(src).toMatch(/const brandDomain = React\.useMemo\(\(\) => \(showRecipient \? undefined : brandIndicatorDomain\(item\)\), \[showRecipient, item\]\);/);
    expect(src).toMatch(/senderWarning=\{senderWarning\}\s+brandDomain=\{brandDomain\}/);
  });

  it('gives unified inbox rows the brand domain', () => {
    const src = read('screens/UnifiedInboxScreen.tsx');
    expect(src).toMatch(/brandDomain=\{showRecipient \? undefined : brandIndicatorDomain\(item\)\}/);
  });

  it('gives the reader header and collapsed thread cards the brand domain', () => {
    expect(read('components/email/MessageHeader.tsx')).toMatch(/brandDomain=\{brandIndicatorDomain\(email\)\}/);
    expect(read('components/email/ThreadMessageCard.tsx')).toMatch(
      /<SenderAvatar [^>]*brandDomain=\{brandIndicatorDomain\(email\)\}/,
    );
  });

  it('fetches the Authentication-Results the helper reads', async () => {
    const { EMAIL_FULL_PROPERTIES, EMAIL_LIST_PROPERTIES, THREAD_HEADER_PROPERTIES } = await import('../../api/email');
    expect(EMAIL_FULL_PROPERTIES).toContain('headers');
    expect(EMAIL_LIST_PROPERTIES).toContain('header:Authentication-Results:all');
    expect(THREAD_HEADER_PROPERTIES).toContain('header:Authentication-Results:all');
    expect(read('api/unified-inbox.ts')).toMatch(/const EMAIL_LIST_PROPERTIES = \[[^\]]*LIST_AUTH_RESULTS_PROPERTY/);
  });
});
