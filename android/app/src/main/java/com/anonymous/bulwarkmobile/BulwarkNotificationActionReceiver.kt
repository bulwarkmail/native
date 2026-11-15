package com.anonymous.bulwarkmobile

import android.app.Application
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log
import android.widget.Toast
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import kotlin.concurrent.thread

class BulwarkNotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val notificationId = intent.getStringExtra(BulwarkFcmModule.EXTRA_NOTIFICATION_ID)
        val action = intent.getStringExtra(BulwarkFcmModule.EXTRA_ACTION)
        val emailId = intent.getStringExtra(NotificationTapStore.EXTRA_EMAIL_ID)
        val accountId = intent.getStringExtra(NotificationTapStore.EXTRA_ACCOUNT_ID)
        val jmapAccountId = intent.getStringExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID)

        // Dismiss the notification immediately from the tray and clean up the
        // group summary if fewer than two child notifications remain.
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notificationId != null) {
            manager.cancel(notificationId, notificationId.hashCode())
        }
        if (!accountId.isNullOrBlank()) {
            BulwarkFcmModule.refreshGroupSummaryAfterCancel(context, accountId)
        }

        if (action == "copyCode") {
            copyCode(context, intent)
            return
        }

        if (emailId.isNullOrBlank() || action.isNullOrBlank() || accountId.isNullOrBlank()) {
            Log.w(TAG, "Missing parameters for notification action: action=$action, emailId=$emailId, accountId=$accountId")
            return
        }

        // On Android 8+, a broadcast receiver in background cannot start a Service
        // (BackgroundServiceStartNotAllowedException). We use goAsync() and execute
        // the JMAP action natively first (avoiding the background JS freeze on Samsung
        // One UI, #94), falling back to HeadlessJs only if native execution fails.
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

        thread(name = "bulwark-notif-action") {
            if (BulwarkNativePushFetcher.executeNotificationAction(app, action, emailId, accountId, jmapAccountId)) {
                Log.i(TAG, "Notification action '$action' ($emailId) handled natively via Kotlin")
                mainHandler.removeCallbacks(timeoutRunnable)
                try {
                    pendingResult.finish()
                } catch (_: Exception) {}
                return@thread
            }

            mainHandler.post {
                dispatchHeadlessActionFallback(app, mainHandler, timeoutRunnable, pendingResult, action, emailId, accountId, jmapAccountId)
            }
        }
    }

    private fun dispatchHeadlessActionFallback(
        app: Application,
        mainHandler: Handler,
        timeoutRunnable: Runnable,
        pendingResult: PendingResult,
        action: String,
        emailId: String,
        accountId: String,
        jmapAccountId: String?,
    ) {
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

    // Copies the sign-in code the notification offered (OtpCode), marked
    // sensitive so the clipboard preview of Android 13+ hides it. Older
    // Android confirms nothing itself: a toast says it was copied.
    private fun copyCode(context: Context, intent: Intent) {
        val code = intent.getStringExtra(BulwarkFcmModule.EXTRA_CODE)
        if (code.isNullOrBlank()) return
        // The label is the app's name: a clipboard viewer may show the label
        // even where it hides the sensitive text.
        val clip = ClipData.newPlainText(context.getString(R.string.app_name), code).apply {
            description.extras = PersistableBundle().apply {
                // ClipDescription.EXTRA_IS_SENSITIVE, a constant of API 33.
                putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
        }
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(clip)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            val label = intent.getStringExtra(BulwarkFcmModule.EXTRA_CODE_COPIED_LABEL)
                ?: context.getString(R.string.notification_code_copied)
            Toast.makeText(context, label, Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        private const val TAG = "BulwarkNotifAction"
    }
}
