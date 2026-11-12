// The account's group summary on Android while the organisation hides notification content.
// The push task takes the account's message notifications out of the tray and posts one plain
// notification for all new mail of the account, so the group is down to a single notification.
// postGroupSummary leaves a summary alone below its threshold (cancelling a summary takes its last
// notification with it); left alone, a summary posted earlier keeps the sender and subject lines
// and the count of the notifications just taken out. Under the rule it is posted again instead,
// without lines and without a number, and no summary is made where none is showing.
//
// Source check, as push-without-content-android-native.test.ts does: nothing native runs here.
// NotificationSummaryTest.kt covers NotificationSummary.posts and NotificationSummary.countText.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const KOTLIN = path.resolve(__dirname, '../../../android/app/src/main/java/com/anonymous/bulwarkmobile');

function postGroupSummaryBody(): string {
  const fcm = fs.readFileSync(path.join(KOTLIN, 'BulwarkFcmModule.kt'), 'utf8');
  const start = fcm.indexOf('private fun postGroupSummary(');
  expect(start).toBeGreaterThan(0);
  return fcm.slice(start, fcm.indexOf('manager.notify(groupKey', start));
}

describe('the account summary while notification content is hidden', () => {
  it('is posted again over a single notification when one is showing, instead of being left as it was', () => {
    const body = postGroupSummaryBody();
    expect(body, 'a plain early return below the threshold leaves the old summary up').not.toMatch(
      /if \(children\.size < minChildren\) return/,
    );
    expect(body).toMatch(/NotificationSummary\.posts\(children\.size, minChildren, withoutContent, summaryShowing\)/);
    expect(body).toMatch(/FLAG_GROUP_SUMMARY\) != 0/);
  });

  it('shows no number of messages', () => {
    const body = postGroupSummaryBody();
    expect(body).toMatch(/NotificationSummary\.countText\(count, withoutContent\)/);
    expect(body, 'the count text is built in NotificationSummary').not.toContain('new messages"');
  });
});
