import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// New mail plays the Involved sound, the webmail's default
// (lib/notification-sound.ts). Native code, so these read the sources: on
// Android a channel of its own (a channel's sound is fixed once created), on
// iOS the notification service extension names the bundled file.

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KOTLIN = 'android/app/src/main/java/com/anonymous/bulwarkmobile';

describe('Involved sound for new mail', () => {
  const service = read(`${KOTLIN}/BulwarkMessagingService.kt`);
  const fcm = read(`${KOTLIN}/BulwarkFcmModule.kt`);

  it('creates a new Android channel with the Involved sound and keeps the old id', () => {
    expect(service).toMatch(/const val CHANNEL_ID = "bulwark_mail_involved"/);
    expect(service).toMatch(/const val LEGACY_CHANNEL_ID = "bulwark_mail"/);
    expect(service).toContain('android.resource://${context.packageName}/raw/involved_notification');
    expect(service).toMatch(/setSound\(sound, attributes\)/);
    expect(service).toContain('AudioAttributes.USAGE_NOTIFICATION');
  });

  it('keeps using the old channel when the user turned it off', () => {
    const fn = service.slice(service.indexOf('fun channelId('), service.indexOf('fun soundUri('));
    expect(fn).toContain('getNotificationChannel(LEGACY_CHANNEL_ID)');
    expect(fn).toContain('IMPORTANCE_NONE');
    // No new channel is created for such a user.
    const ensure = service.slice(service.indexOf('fun ensureChannel('));
    expect(ensure).toMatch(/if \(channelId\(context\) != CHANNEL_ID\) return/);
  });

  it('posts mail notifications to the channel channelId() picks', () => {
    expect(fcm).not.toContain('BulwarkMessagingService.CHANNEL_ID');
    expect(fcm.match(/NotificationCompat\.Builder\(ctx, BulwarkMessagingService\.channelId\(ctx\)\)/g)).toHaveLength(2);
  });

  it('ships the sound on both platforms', () => {
    expect(fs.existsSync(path.join(ROOT, 'android/app/src/main/res/raw/involved_notification.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'assets/sounds/involved_notification.wav'))).toBe(true);
    expect(read('app.config.js')).toContain("sounds: ['./assets/sounds/involved_notification.wav']");
  });

  it('names the bundled sound in the iOS notification extension, placeholder included', () => {
    const nse = read('plugins/ios-push/NotificationService.swift');
    const sound = nse.indexOf('content.sound = UNNotificationSound(named: UNNotificationSoundName("involved_notification.wav"))');
    expect(sound).toBeGreaterThan(-1);
    expect(sound).toBeLessThan(nse.indexOf('placeholder = content'));
  });
});
