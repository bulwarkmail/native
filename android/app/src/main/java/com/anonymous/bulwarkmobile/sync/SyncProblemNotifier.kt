package com.anonymous.bulwarkmobile.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import com.anonymous.bulwarkmobile.MainActivity
import com.anonymous.bulwarkmobile.R

/**
 * The one notification per Android account that device sync needs the user
 * for (#34), e.g. "Sign in again" after the server rejected the credentials.
 * The engine posts it through `showSyncProblem`; the app clears it once the
 * problem is solved. Tapping it opens a `bulwarkmobile://` deep link in the
 * app.
 */
object SyncProblemNotifier {
    const val CHANNEL_ID = "bulwark_sync"
    private const val DEFAULT_CHANNEL_NAME = "Sync problems"
    private const val TAG_PREFIX = "bulwark-sync:"
    private const val NOTIFICATION_ID = 1
    private const val DEEP_LINK_SCHEME = "bulwarkmobile"

    /**
     * Creates the channel, or renames it: JS passes the name in the app's
     * language. Nothing urgent, so default importance and no vibration.
     */
    fun ensureChannel(context: Context, name: String?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            name?.takeIf { it.isNotBlank() } ?: DEFAULT_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { enableVibration(false) }
        manager.createNotificationChannel(channel)
    }

    fun show(context: Context, accountName: String, title: String, text: String, uri: String, channelName: String?) {
        val link = Uri.parse(uri)
        require(link.scheme == DEEP_LINK_SCHEME) { "Only $DEEP_LINK_SCHEME:// links open from a sync notification" }
        ensureChannel(context, channelName)
        val tag = TAG_PREFIX + accountName
        // Explicit, so no other app can answer the tap.
        val intent = Intent(Intent.ACTION_VIEW, link, context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            // Runs repeat the same problem until it is solved; say it once.
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(tag, NOTIFICATION_ID, notification)
    }

    fun clear(context: Context, accountName: String) {
        context.getSystemService(NotificationManager::class.java).cancel(TAG_PREFIX + accountName, NOTIFICATION_ID)
    }
}
