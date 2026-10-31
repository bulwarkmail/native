package com.anonymous.bulwarkmobile

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.anonymous.bulwarkmobile.sync.DeviceSyncPushRouter
import com.facebook.react.bridge.Arguments
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class BulwarkMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val params = Arguments.createMap().apply { putString("token", token) }
        BulwarkFcmModule.emit("fcm:newToken", params)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        ensureChannel(this)

        val data = message.data

        // Contact and calendar changes become syncs of the Android accounts
        // they feed (device sync, #34); only mail needs the push task.
        val mail = DeviceSyncPushRouter.route(applicationContext, data)

        // Hand off to JS via a headless task only when the app isn't already
        // running in the foreground - HeadlessJsTaskContext throws if started
        // while foreground. When the app is open, the main JS instance already
        // receives JMAP push directly, so the fcm:message event below is
        // sufficient for it to refresh state.
        if (mail && !isAppInForeground()) {
            startHeadlessTask(applicationContext, data)
        }

        val params = Arguments.createMap().apply {
            val dataMap = Arguments.createMap()
            for ((k, v) in data) dataMap.putString(k, v)
            putMap("data", dataMap)
        }
        BulwarkFcmModule.emit("fcm:message", params)
    }

    companion object {
        // Plays the Involved sound; see channelId().
        const val CHANNEL_ID = "bulwark_mail_involved"
        // The first mail channel, with the system's default sound.
        const val LEGACY_CHANNEL_ID = "bulwark_mail"
        private const val TAG = "BulwarkPush"
        private const val START_WAKE_LOCK_MS = 10_000L

        // Shared with BulwarkUnifiedPushService - a push arriving over either
        // transport is dispatched the same way.
        fun isAppInForeground(): Boolean {
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
                info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
        }

        fun startHeadlessTask(context: Context, data: Map<String, String>) {
            val intent = Intent(context, BulwarkPushTaskService::class.java)
            val bundle = Bundle().apply {
                for ((k, v) in data) putString(k, v)
            }
            intent.putExtras(bundle)
            // Keep the device awake until the service holds React Native's
            // wake lock; BulwarkPushTaskService releases this one then. Not
            // HeadlessJsTaskService.acquireWakeLockNow: it is not
            // thread-safe, and FCM calls this on a worker thread while the
            // service takes the same static lock on the main thread, so both
            // could create a lock and the overwritten one stayed held.
            startWakeLock = context.getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bulwark:push-start")
                .apply {
                    setReferenceCounted(false)
                    acquire(START_WAKE_LOCK_MS)
                }
            try {
                context.startService(intent)
            } catch (e: IllegalStateException) {
                // Android 8+ refuses to start a service from the background
                // unless the app is temporarily allowlisted. A high-priority
                // FCM message does that; a downgraded one or a UnifiedPush
                // message may not (BackgroundServiceStartNotAllowedException
                // on 12+), and uncaught this crashed the app on every such
                // push. Run the same task from a job instead.
                releaseStartWakeLock()
                Log.w(TAG, "Push service start refused in the background, using a job: ${e.message}")
                BulwarkPushJobService.schedule(context, data)
            }
        }

        @Volatile private var startWakeLock: PowerManager.WakeLock? = null

        /** Drops the wake lock taken in [startHeadlessTask]; it also times out on its own. */
        fun releaseStartWakeLock() {
            startWakeLock?.release()
            startWakeLock = null
        }

        /**
         * The channel new-mail notifications go to. A channel's sound can't
         * change after it is created, so the Involved sound (the webmail's
         * default, lib/notification-sound.ts) needs a channel of its own; the
         * old one stays as the user left it. Someone who turned mail
         * notifications off in the old channel keeps them off: their
         * notifications keep going there.
         */
        fun channelId(context: Context): String {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return CHANNEL_ID
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val legacy = manager.getNotificationChannel(LEGACY_CHANNEL_ID)
            return if (legacy != null && legacy.importance == NotificationManager.IMPORTANCE_NONE) {
                LEGACY_CHANNEL_ID
            } else {
                CHANNEL_ID
            }
        }

        /** The Involved sound (res/raw, kept from the shrinker by res/raw/keep.xml). */
        fun soundUri(context: Context): Uri =
            Uri.parse("android.resource://${context.packageName}/raw/involved_notification")

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (channelId(context) != CHANNEL_ID) return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val sound = soundUri(context)
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mail notifications",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Incoming email alerts"
                enableVibration(true)
                setSound(sound, attributes)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
