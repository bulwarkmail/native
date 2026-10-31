import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Offline send as wired in ComposeScreen and the offline banner, checked on
// their source (the suite has no RN renderer).
const compose = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
const banner = fs.readFileSync(path.resolve(__dirname, '../../components/OfflineBanner.tsx'), 'utf8');

describe('ComposeScreen offline send', () => {
  const send = compose.slice(compose.indexOf('const performSendInner'), compose.indexOf('const titleKey'));

  it('queues the message instead of trying while offline', () => {
    const offline = send.indexOf('if (!useNetworkStore.getState().online && queueForLater(outgoing, false)) return;');
    expect(offline).toBeGreaterThan(-1);
    // Before anything goes to the server.
    expect(offline).toBeLessThan(send.indexOf('await sendTargetFor('));
  });

  it('queues a send whose connection failed, marked as possibly sent, ahead of the other failure messages', () => {
    const queued = send.indexOf('shouldQueueFailedSend(classifySendFailure(e, isTransientNetworkError))');
    expect(queued).toBeGreaterThan(-1);
    expect(send).toMatch(/&& queueForLater\(queuedOutgoing, true\)\) \{\s+return;/);
    expect(queued).toBeLessThan(send.indexOf('if (e instanceof RequestTimeoutError)'));
  });

  it("queues into the login the message was written in, and hands the Outbox the autosaved draft", () => {
    const queue = send.slice(send.indexOf('const queueForLater'), send.indexOf('setSending(true);'));
    expect(queue).toMatch(/if \(outbox\.activeAccountId !== ownerLoginRef\.current\) return false;/);
    expect(queue).toMatch(/draftId: draftIdRef\.current \?\? undefined,/);
    expect(queue).toMatch(/if \(!queuedId\) return false;\s+draftIdRef\.current = null;/);
    expect(queue).toMatch(/navigation\.goBack\(\);/);
  });
});

describe('OfflineBanner Outbox', () => {
  it('shows the Outbox while messages wait, online too, and opens it', () => {
    expect(banner).toMatch(/const sends = useOutboxStore\(\(s\) => s\.sends\);/);
    expect(banner).toMatch(/if \(online && !sendsHint\) return null;/);
    expect(banner).toMatch(/onPress=\{\(\) => setOutboxOpen\(true\)\}/);
    expect(banner).toMatch(/<OutboxSheet visible=\{outboxOpen\}/);
  });
});
