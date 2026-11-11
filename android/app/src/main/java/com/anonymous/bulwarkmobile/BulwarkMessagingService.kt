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
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.anonymous.bulwarkmobile.sync.DeviceSyncPushRouter
import com.anonymous.bulwarkmobile.sync.PushRouting
import com.facebook.react.bridge.Arguments
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.concurrent.thread

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
        val decision = DeviceSyncPushRouter.route(applicationContext, data)

        startTaskUnlessInForeground(applicationContext, data, decision)

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

        /**
         * Runs the push task for a mail push unless the app's screen is
         * resumed: then the user is looking at the app, which syncs over its
         * own event stream, and HeadlessJsTaskContext would refuse the task.
         * Shared with BulwarkUnifiedPushService, so a push arriving over
         * either transport is dispatched the same way.
         *
         * A change to mail already there (#96) removes the notifications it
         * made stale, in the foreground too: the app's own sync leaves the
         * tray alone.
         *
         * The process importance is no measure of that (#94): an app paused
         * under a translucent screen, or kept important by anything bound to
         * it, counts as foreground, and its pushes ended without a
         * notification.
         */
        fun startTaskUnlessInForeground(context: Context, data: Map<String, String>, decision: PushRouting.Decision) {
            val foreground = MainActivity.isInForeground
            val mail = decision.startMailTask && !foreground
            Log.i(
                TAG,
                "Push: mail=${decision.startMailTask} changes=${decision.reconcile.size} " +
                    "foreground=$foreground importance=${processImportance()}",
            )
            if (mail || decision.reconcile.isNotEmpty()) {
                val appContext = context.applicationContext
                val runPush = {
                    // One push can name new mail for one account and changes for
                    // another: the new mail goes first, and the stale check gets
                    // what is left of the same budget.
                    val deadlineMs = System.currentTimeMillis() + BulwarkNativePushFetcher.PUSH_BUDGET_MS
                    var jsTaskStarted = false
                    if (mail) {
                        if (BulwarkNativePushFetcher.processPush(appContext, data)) {
                            Log.i(TAG, "Push handled natively via Kotlin")
                            if (BulwarkNativePushFetcher.pushSubscriptionDueForExtension(appContext, data)) {
                                // Only the JS task extends the subscription; it finds
                                // the mail already notified.
                                Log.i(TAG, "Push subscription due for extension, starting the push task too")
                                HttpConnections.dropIdle()
                                startHeadlessTask(appContext, data)
                                jsTaskStarted = true
                            }
                        } else {
                            // The task opens its own connection rather than one left
                            // over from the foreground, which may be dead (#94).
                            HttpConnections.dropIdle()
                            startHeadlessTask(appContext, data)
                            jsTaskStarted = true
                        }
                    }
                    // With the JS task running, a native check could refresh the
                    // same login's token at the same time (034922b): the
                    // notifications are checked on the next change push instead.
                    if (decision.reconcile.isNotEmpty() && !jsTaskStarted) {
                        BulwarkNativePushFetcher.reconcileNotifications(
                            appContext, decision.reconcile, data["accountLabel"], deadlineMs,
                        )
                    }
                }
                if (Looper.myLooper() == Looper.getMainLooper()) {
                    // UnifiedPush invokes onMessage from a BroadcastReceiver on the main
                    // thread, where synchronous network I/O throws NetworkOnMainThreadException.
                    val wakeLock = appContext.getSystemService(PowerManager::class.java)
                        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bulwark:native-push")
                        .apply {
                            setReferenceCounted(false)
                            acquire(START_WAKE_LOCK_MS)
                        }
                    thread(name = "bulwark-native-push") {
                        try {
                            runPush()
                        } finally {
                            if (wakeLock.isHeld) wakeLock.release()
                        }
                    }
                } else {
                    runPush()
                }
            }
        }

        /** For the log only. */
        private fun processImportance(): Int {
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            return info.importance
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
