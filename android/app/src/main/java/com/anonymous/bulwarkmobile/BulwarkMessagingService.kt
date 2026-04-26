package com.anonymous.bulwarkmobile

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
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

        // Hand off to JS via a headless task only when the app isn't already
        // running in the foreground — HeadlessJsTaskContext throws if started
        // while foreground. When the app is open, the main JS instance already
        // receives JMAP push directly, so the fcm:message event below is
        // sufficient for it to refresh state.
        if (!isAppInForeground()) {
            startHeadlessTask(data)
        }

        val params = Arguments.createMap().apply {
            val dataMap = Arguments.createMap()
            for ((k, v) in data) dataMap.putString(k, v)
            putMap("data", dataMap)
        }
        BulwarkFcmModule.emit("fcm:message", params)
    }

    private fun isAppInForeground(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    private fun startHeadlessTask(data: Map<String, String>) {
        val intent = Intent(applicationContext, BulwarkPushTaskService::class.java)
        val bundle = Bundle().apply {
            for ((k, v) in data) putString(k, v)
        }
        intent.putExtras(bundle)
        applicationContext.startService(intent)
        HeadlessJsTaskService.acquireWakeLockNow(applicationContext)
    }

    companion object {
        const val CHANNEL_ID = "bulwark_mail"

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mail notifications",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Incoming email alerts"
                enableVibration(true)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
