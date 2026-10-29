package com.anonymous.bulwarkmobile

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import com.google.firebase.messaging.FirebaseMessaging
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class BulwarkFcmModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    init {
        synchronized(BulwarkFcmModule::class.java) {
            currentInstance = this
        }
        BulwarkMessagingService.ensureChannel(reactContext)
    }

    override fun getName(): String = "BulwarkFcm"

    @ReactMethod
    fun getToken(promise: Promise) {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> promise.resolve(token) }
            .addOnFailureListener { err -> promise.reject("fcm_token_failed", err) }
    }

    @ReactMethod
    fun deleteToken(promise: Promise) {
        FirebaseMessaging.getInstance().deleteToken()
            .addOnSuccessListener { promise.resolve(null) }
            .addOnFailureListener { err -> promise.reject("fcm_delete_failed", err) }
    }

    @ReactMethod
    fun showNotification(options: ReadableMap, promise: Promise) {
        val notificationId = options.getString("notificationId")
        if (notificationId.isNullOrBlank()) {
            promise.reject("bad_args", "notificationId is required")
            return
        }
        val title = options.getString("title") ?: "New mail"
        val body = options.getString("body") ?: ""
        val initials = options.getString("initials") ?: "?"
        val bgColorHex = options.getString("bgColorHex") ?: "#2563eb"
        val iconUrl = options.takeIf { it.hasKey("iconUrl") }?.getString("iconUrl")
        val emailId = options.getString("emailId")
        val threadId = options.getString("threadId")
        val subject = options.takeIf { it.hasKey("subject") }?.getString("subject")
        val accountId = options.takeIf { it.hasKey("accountId") }?.getString("accountId")
        val jmapAccountId = options.takeIf { it.hasKey("jmapAccountId") }?.getString("jmapAccountId")
        val groupKey = options.takeIf { it.hasKey("groupKey") }?.getString("groupKey")
            ?: accountId?.let { "bulwark-mail:$it" }
        val groupTitle = options.takeIf { it.hasKey("groupTitle") }?.getString("groupTitle")
            ?: accountId ?: "Bulwark Mail"

        val preview = options.takeIf { it.hasKey("preview") }?.getString("preview")
        val markReadLabel = options.takeIf { it.hasKey("markReadLabel") }?.getString("markReadLabel") ?: "Mark as read"
        val deleteLabel = options.takeIf { it.hasKey("deleteLabel") }?.getString("deleteLabel") ?: "Delete"
        val replyLabel = options.takeIf { it.hasKey("replyLabel") }?.getString("replyLabel") ?: "Reply"

        // Bitmap fetch + draw off the bridge thread so the caller doesn't
        // block waiting for the favicon request.
        thread(name = "bulwark-notification") {
            val largeIcon = iconUrl?.let { fetchBitmap(it) }
                ?: makeLetterAvatar(initials, bgColorHex)
            postNotification(
                notificationId, title, body, preview, largeIcon, bgColorHex,
                emailId, threadId, subject, accountId, jmapAccountId, groupKey,
                groupTitle, markReadLabel, deleteLabel, replyLabel,
            )
            if (groupKey != null) postGroupSummary(groupKey, groupTitle, bgColorHex, accountId)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun getInitialNotification(promise: Promise) {
        val payload = NotificationTapStore.consume()
        promise.resolve(payload?.toMap())
    }

    @ReactMethod
    fun getInitialShare(promise: Promise) {
        val payload = ShareIntentStore.consume()
        promise.resolve(payload?.toMap())
    }

    private fun postNotification(
        notificationId: String,
        title: String,
        body: String,
        preview: String?,
        largeIcon: Bitmap,
        colorHex: String,
        emailId: String?,
        threadId: String?,
        subject: String?,
        accountId: String?,
        jmapAccountId: String?,
        groupKey: String?,
        groupTitle: String?,
        markReadLabel: String,
        deleteLabel: String,
        replyLabel: String,
    ) {
        val ctx = reactApplicationContext
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            data = Uri.parse("bulwark-notification://$notificationId")
            if (emailId != null) putExtra(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
            if (threadId != null) putExtra(NotificationTapStore.EXTRA_THREAD_ID, threadId)
            if (subject != null) putExtra(NotificationTapStore.EXTRA_SUBJECT, subject)
            if (accountId != null) putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
            if (jmapAccountId != null) putExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
        }
        val pending = PendingIntent.getActivity(
            ctx,
            notificationId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val bigText = buildString {
            if (!subject.isNullOrBlank()) append(subject)
            if (!preview.isNullOrBlank()) {
                if (isNotEmpty()) append("\n")
                append(preview)
            }
        }

        val builder = NotificationCompat.Builder(ctx, BulwarkMessagingService.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(largeIcon)
            .setContentTitle(title)
            // body is the subject with the "(No subject)" fallback; an empty
            // subject is "" here, not null, so `subject ?: ...` showed a blank line.
            .setContentText(body)
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(if (bigText.isNotBlank()) bigText else body)
                    .setBigContentTitle(title)
                    .setSummaryText(groupTitle)
            )
            .setColor(parseColor(colorHex, fallback = Color.parseColor("#2563eb")))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
        if (groupKey != null) {
            builder.setGroup(groupKey)
            builder.setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
        }

        if (emailId != null && accountId != null) {
            // Action 1: Mark as read
            val markReadIntent = Intent(ctx, BulwarkNotificationActionReceiver::class.java).apply {
                action = ACTION_MARK_READ
                data = Uri.parse("bulwark-action-read://$notificationId")
                putExtra(EXTRA_NOTIFICATION_ID, notificationId)
                putExtra(EXTRA_ACTION, "markRead")
                putExtra(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
                putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
                if (jmapAccountId != null) putExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
            }
            val markReadPending = PendingIntent.getBroadcast(
                ctx,
                (notificationId + ":read").hashCode(),
                markReadIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(0, markReadLabel, markReadPending).build()
            )

            // Action 2: Delete
            val deleteIntent = Intent(ctx, BulwarkNotificationActionReceiver::class.java).apply {
                action = ACTION_DELETE
                data = Uri.parse("bulwark-action-delete://$notificationId")
                putExtra(EXTRA_NOTIFICATION_ID, notificationId)
                putExtra(EXTRA_ACTION, "delete")
                putExtra(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
                putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
                if (jmapAccountId != null) putExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
            }
            val deletePending = PendingIntent.getBroadcast(
                ctx,
                (notificationId + ":delete").hashCode(),
                deleteIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(0, deleteLabel, deletePending)
                    // Android 12+: unlock first, so a locked phone can't delete mail.
                    .setAuthenticationRequired(true)
                    .build()
            )

            // Action 3: Reply
            val replyIntent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                data = Uri.parse("bulwark-reply://$notificationId")
                putExtra(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
                if (threadId != null) putExtra(NotificationTapStore.EXTRA_THREAD_ID, threadId)
                if (subject != null) putExtra(NotificationTapStore.EXTRA_SUBJECT, subject)
                putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
                if (jmapAccountId != null) putExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
                putExtra(EXTRA_ACTION, "reply")
            }
            val replyPending = PendingIntent.getActivity(
                ctx,
                (notificationId + ":reply").hashCode(),
                replyIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(0, replyLabel, replyPending).build()
            )
        }

        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId, notificationId.hashCode(), builder.build())
    }

    // One summary per account group so several deliveries collapse into a
    // single "N new messages" entry (Android renders the "+N more" itself
    // from the children). Tapping the summary opens the app on the inbox;
    // the per-message children carry the deep link.
    private fun postGroupSummary(groupKey: String, groupTitle: String, colorHex: String, accountId: String?) {
        val ctx = reactApplicationContext
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val children = manager.activeNotifications.filter {
            it.groupKey?.endsWith(groupKey) == true &&
                (it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY) == 0
        }
        if (children.size < 2) {
            manager.cancel(groupKey, groupKey.hashCode())
            return
        }
        val count = children.size
        val inbox = NotificationCompat.InboxStyle()
        children.sortedByDescending { it.postTime }.take(5).forEach { sbn ->
            val extras = sbn.notification.extras
            val line = listOfNotNull(
                extras.getCharSequence(android.app.Notification.EXTRA_TITLE),
                extras.getCharSequence(android.app.Notification.EXTRA_TEXT),
            ).joinToString("  ")
            if (line.isNotBlank()) inbox.addLine(line)
        }
        inbox.setBigContentTitle(groupTitle)
        inbox.setSummaryText(if (count == 1) "1 new message" else "$count new messages")

        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            data = Uri.parse("bulwark-group-summary://$groupKey")
            if (accountId != null) putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
        }
        val pending = PendingIntent.getActivity(
            ctx,
            groupKey.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val summary = NotificationCompat.Builder(ctx, BulwarkMessagingService.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(groupTitle)
            .setContentText(if (count == 1) "1 new message" else "$count new messages")
            .setStyle(inbox)
            .setColor(parseColor(colorHex, fallback = Color.parseColor("#2563eb")))
            .setGroup(groupKey)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        manager.notify(groupKey, groupKey.hashCode(), summary)
    }

    private fun makeLetterAvatar(initials: String, bgHex: String): Bitmap {
        val size = 192
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = parseColor(bgHex, fallback = Color.parseColor("#2563eb"))
        }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, bgPaint)
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = size * 0.44f
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        val baseline = size / 2f - (textPaint.descent() + textPaint.ascent()) / 2f
        canvas.drawText(initials.take(2).uppercase(), size / 2f, baseline, textPaint)
        return bitmap
    }

    private fun fetchBitmap(url: String): Bitmap? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 3000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "bulwark-mobile")
        // Cap the response to MAX_FAVICON_BYTES so a hostile / misconfigured
        // server can't OOM the headless task with a multi-megabyte image.
        // We also sample down to ~256x256 since it'll only render at 192px.
        val stream = conn.inputStream
        val bytes = stream.use { input ->
            val limit = MAX_FAVICON_BYTES
            val buf = ByteArrayOutputStream()
            val chunk = ByteArray(8 * 1024)
            var total = 0
            while (true) {
                val n = input.read(chunk)
                if (n <= 0) break
                total += n
                if (total > limit) return@use null
                buf.write(chunk, 0, n)
            }
            buf.toByteArray()
        } ?: return null
        val opts = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        var sample = 1
        while ((opts.outWidth / sample) > 384 || (opts.outHeight / sample) > 384) {
            sample *= 2
        }
        val decodeOpts = BitmapFactory.Options().apply {
            inSampleSize = sample
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts)
    } catch (_: Exception) {
        null
    }

    private fun parseColor(hex: String, fallback: Int): Int = try {
        Color.parseColor(hex)
    } catch (_: IllegalArgumentException) {
        fallback
    }

    // NativeEventEmitter required no-ops.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    companion object {
        // 1 MiB is plenty for a favicon; anything bigger is a sign of trouble.
        private const val MAX_FAVICON_BYTES = 1 * 1024 * 1024

        @Volatile private var currentInstance: BulwarkFcmModule? = null

        const val EXTRA_ACTION = "bulwark.notification.action"
        const val EXTRA_NOTIFICATION_ID = "bulwark.notification.notificationId"
        const val ACTION_MARK_READ = "com.anonymous.bulwarkmobile.ACTION_MARK_READ"
        const val ACTION_DELETE = "com.anonymous.bulwarkmobile.ACTION_DELETE"

        fun emit(eventName: String, params: WritableMap?) {
            val module = currentInstance ?: return
            val ctx = module.reactApplicationContext
            if (!ctx.hasActiveReactInstance()) return
            ctx.getJSModule(RCTDeviceEventEmitter::class.java).emit(eventName, params)
        }
    }
}
