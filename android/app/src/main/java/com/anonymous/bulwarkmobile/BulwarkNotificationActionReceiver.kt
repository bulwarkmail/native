package com.anonymous.bulwarkmobile

import android.app.Application
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

class BulwarkNotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val notificationId = intent.getStringExtra(BulwarkFcmModule.EXTRA_NOTIFICATION_ID)
        val action = intent.getStringExtra(BulwarkFcmModule.EXTRA_ACTION)
        val emailId = intent.getStringExtra(NotificationTapStore.EXTRA_EMAIL_ID)
        val accountId = intent.getStringExtra(NotificationTapStore.EXTRA_ACCOUNT_ID)
        val jmapAccountId = intent.getStringExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID)

        // Dismiss the notification immediately from the tray
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notificationId != null) {
            manager.cancel(notificationId, notificationId.hashCode())
        }

        if (emailId.isNullOrBlank() || action.isNullOrBlank() || accountId.isNullOrBlank()) {
            Log.w(TAG, "Missing parameters for notification action: action=$action, emailId=$emailId, accountId=$accountId")
            return
        }

        // On Android 8+, a broadcast receiver in background cannot start a Service
        // (BackgroundServiceStartNotAllowedException). Instead, we use goAsync() and
        // HeadlessJs.withReadyReactContext to execute the headless JS task directly.
        val pendingResult = goAsync()
        val app = context.applicationContext as Application
        val mainHandler = Handler(Looper.getMainLooper())

        // Safety timeout to ensure pendingResult.finish() is always called
        val timeoutRunnable = Runnable {
            Log.w(TAG, "Notification action task timed out or failed to initialize ($action, $emailId)")
            try {
                pendingResult.finish()
            } catch (_: Exception) {}
        }
        mainHandler.postDelayed(timeoutRunnable, 20_000L)

        try {
            HeadlessJs.withReadyReactContext(app) { reactContext ->
                if (!reactContext.hasActiveReactInstance()) {
                    Log.w(TAG, "React context does not have active instance")
                    mainHandler.removeCallbacks(timeoutRunnable)
                    try {
                        pendingResult.finish()
                    } catch (_: Exception) {}
                    return@withReadyReactContext
                }

                val tasks = HeadlessJsTaskContext.getInstance(reactContext)
                val taskBundle = Bundle().apply {
                    putString("action", action)
                    putString("emailId", emailId)
                    putString("accountId", accountId)
                    if (jmapAccountId != null) putString("jmapAccountId", jmapAccountId)
                    // Keep raw extras as well
                    putString(BulwarkFcmModule.EXTRA_ACTION, action)
                    putString(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
                    putString(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
                    if (jmapAccountId != null) putString(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
                }

                val config = HeadlessJsTaskConfig(
                    "BulwarkNotificationAction",
                    Arguments.fromBundle(taskBundle),
                    15_000L,
                    true // allowExecutionInForeground
                )

                val listener = object : HeadlessJsTaskEventListener {
                    override fun onHeadlessJsTaskStart(taskId: Int) = Unit
                    override fun onHeadlessJsTaskFinish(taskId: Int) {
                        Log.i(TAG, "Notification action task $taskId finished for action $action")
                        tasks.removeTaskEventListener(this)
                        mainHandler.removeCallbacks(timeoutRunnable)
                        try {
                            pendingResult.finish()
                        } catch (_: Exception) {}
                    }
                }
                tasks.addTaskEventListener(listener)

                HeadlessJs.startTask(
                    tasks,
                    config,
                    onStarted = { taskId ->
                        Log.i(TAG, "Started notification action task $taskId for action $action ($emailId)")
                    },
                    onRefused = { e ->
                        Log.w(TAG, "Notification action task refused: ${e.message}")
                        tasks.removeTaskEventListener(listener)
                        mainHandler.removeCallbacks(timeoutRunnable)
                        try {
                            pendingResult.finish()
                        } catch (_: Exception) {}
                    }
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to dispatch headless task from action receiver", e)
            mainHandler.removeCallbacks(timeoutRunnable)
            try {
                pendingResult.finish()
            } catch (_: Exception) {}
        }
    }

    companion object {
        private const val TAG = "BulwarkNotifAction"
    }
}
