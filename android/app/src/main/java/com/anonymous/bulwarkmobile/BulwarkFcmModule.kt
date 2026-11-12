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
        val markReadLabel = options.takeIf { it.hasKey("markReadLabel") }?.getString("markReadLabel")
            ?: reactApplicationContext.getString(R.string.notification_action_mark_read)
        val deleteLabel = options.takeIf { it.hasKey("deleteLabel") }?.getString("deleteLabel")
            ?: reactApplicationContext.getString(R.string.notification_action_delete)
        val replyLabel = options.takeIf { it.hasKey("replyLabel") }?.getString("replyLabel")
            ?: reactApplicationContext.getString(R.string.notification_action_reply)
        // Delete moves the mail to Trash where there is one: no unlock needed
        // for that (#85). Without a Trash it destroys the mail, so it asks.
        // Unlock stays the default for a caller that doesn't say.
        val deleteNeedsUnlock = !options.hasKey("deleteNeedsUnlock") || options.getBoolean("deleteNeedsUnlock")
        // The login's organisation wants notifications without content.
        val withoutContent = options.hasKey("withoutContent") && options.getBoolean("withoutContent")
        // Left out where the organisation turned archiving off.
        val archiveLabel = options.takeIf { it.hasKey("archiveLabel") }?.getString("archiveLabel")
        val code = options.takeIf { it.hasKey("verificationCode") }?.getString("verificationCode")
        // A code to copy shows the code itself: not while the content is hidden.
        val copyCode = code?.takeUnless { withoutContent }?.let {
            NotificationCopyCode(
                code = it,
                label = options.takeIf { o -> o.hasKey("copyCodeLabel") }?.getString("copyCodeLabel") ?: "Copy code $it",
                copiedLabel = options.takeIf { o -> o.hasKey("codeCopiedLabel") }?.getString("codeCopiedLabel") ?: "Code copied",
            )
        }

        // Bitmap fetch + draw off the bridge thread so the caller doesn't
        // block waiting for the favicon request.
        thread(name = "bulwark-notification") {
            val largeIcon = iconUrl?.let { fetchBitmap(it) }
                ?: makeLetterAvatar(initials, bgColorHex)
            postNotification(
                reactApplicationContext, notificationId, title, body, preview, largeIcon, bgColorHex,
                emailId, threadId, subject, accountId, jmapAccountId, groupKey,
                groupTitle, markReadLabel, deleteLabel, replyLabel, deleteNeedsUnlock,
                archiveLabel, copyCode,
            )
            if (groupKey != null) {
                postGroupSummary(reactApplicationContext, groupKey, groupTitle, bgColorHex, accountId, withoutContent)
            }
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun savePushAccount(jmapAccountId: String, accountJson: String) {
        val prefs = BulwarkNativePushFetcher.getPrefs(reactApplicationContext)
        prefs.edit().putString(jmapAccountId, accountJson).apply()
    }

    @ReactMethod
    fun removePushAccount(idOrAccountId: String) {
        BulwarkNativePushFetcher.removePushAccount(reactApplicationContext, idOrAccountId)
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

    // NativeEventEmitter required no-ops.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    companion object {
    private fun postNotification(
        ctx: Context,
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
        deleteNeedsUnlock: Boolean,
        archiveLabel: String?,
        copyCode: NotificationCopyCode?,
    ) {
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

        val builder = NotificationCompat.Builder(ctx, BulwarkMessagingService.channelId(ctx))
            .setSmallIcon(R.drawable.ic_notification)
            // Android 7 has no channels: the notification names its sound.
            .setSound(BulwarkMessagingService.soundUri(ctx))
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
            for (name in mailActions(hasCode = copyCode != null, archive = archiveLabel != null)) {
                val action = when (name) {
                    "copyCode" -> copyCodeAction(ctx, notificationId, copyCode!!)
                    "archive" -> broadcastAction(ctx, ACTION_ARCHIVE, "archive", notificationId, emailId, accountId, jmapAccountId)
                        .let { NotificationCompat.Action.Builder(0, archiveLabel, it).build() }
                    "markRead" -> markReadAction(ctx, notificationId, emailId, accountId, jmapAccountId, markReadLabel)
                    "delete" -> deleteAction(ctx, notificationId, emailId, accountId, jmapAccountId, deleteLabel, deleteNeedsUnlock)
                    else -> replyAction(ctx, notificationId, emailId, threadId, subject, accountId, jmapAccountId, replyLabel)
                }
                builder.addAction(action)
            }
        }

        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId, notificationId.hashCode(), builder.build())
    }

    private fun broadcastAction(
        ctx: Context,
        intentAction: String,
        name: String,
        notificationId: String,
        emailId: String,
        accountId: String,
        jmapAccountId: String?,
    ): PendingIntent {
        val intent = Intent(ctx, BulwarkNotificationActionReceiver::class.java).apply {
            action = intentAction
            data = Uri.parse("bulwark-action-$name://$notificationId")
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            putExtra(EXTRA_ACTION, name)
            putExtra(NotificationTapStore.EXTRA_EMAIL_ID, emailId)
            putExtra(NotificationTapStore.EXTRA_ACCOUNT_ID, accountId)
            if (jmapAccountId != null) putExtra(NotificationTapStore.EXTRA_JMAP_ACCOUNT_ID, jmapAccountId)
        }
        return PendingIntent.getBroadcast(
            ctx,
            "$notificationId:$name".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Copies the code in the receiver; the notification stays for the other actions. */
    private fun copyCodeAction(ctx: Context, notificationId: String, copyCode: NotificationCopyCode): NotificationCompat.Action {
        val intent = Intent(ctx, BulwarkNotificationActionReceiver::class.java).apply {
            action = ACTION_COPY_CODE
            data = Uri.parse("bulwark-action-copy://$notificationId")
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            putExtra(EXTRA_ACTION, "copyCode")
            putExtra(EXTRA_CODE, copyCode.code)
            putExtra(EXTRA_CODE_COPIED_LABEL, copyCode.copiedLabel)
        }
        val pending = PendingIntent.getBroadcast(
            ctx,
            "$notificationId:copy".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(0, copyCode.label, pending).build()
    }

    private fun markReadAction(
        ctx: Context,
        notificationId: String,
        emailId: String,
        accountId: String,
        jmapAccountId: String?,
        markReadLabel: String,
    ): NotificationCompat.Action {
        run {
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
            return NotificationCompat.Action.Builder(0, markReadLabel, markReadPending).build()
        }
    }

    private fun deleteAction(
        ctx: Context,
        notificationId: String,
        emailId: String,
        accountId: String,
        jmapAccountId: String?,
        deleteLabel: String,
        deleteNeedsUnlock: Boolean,
    ): NotificationCompat.Action {
        run {
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
            return NotificationCompat.Action.Builder(0, deleteLabel, deletePending)
                // Android 12+: unlock first, so a locked phone can't destroy mail.
                .setAuthenticationRequired(deleteNeedsUnlock)
                .build()
        }
    }

    private fun replyAction(
        ctx: Context,
        notificationId: String,
        emailId: String,
        threadId: String?,
        subject: String?,
        accountId: String,
        jmapAccountId: String?,
        replyLabel: String,
    ): NotificationCompat.Action {
        run {
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
            return NotificationCompat.Action.Builder(0, replyLabel, replyPending).build()
        }
    }

    /**
     * Posts the group summary once the group has [minChildren] notifications,
     * cancels it when it has none. Between the two it is left alone: with a
     * summary up, cancelling it takes its last child down with it. Under the
     * organisation's rule ([withoutContent]) the summary takes no lines and no
     * count from the children, and one that is showing is posted again even
     * over a single child (NotificationSummary).
     */
    private fun postGroupSummary(
        ctx: Context,
        groupKey: String,
        groupTitle: String,
        colorHex: String,
        accountId: String?,
        withoutContent: Boolean = false,
        minChildren: Int = 2,
    ) {
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val children = manager.activeNotifications.filter {
            it.groupKey?.endsWith(groupKey) == true &&
                (it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY) == 0
        }
        if (children.isEmpty()) {
            manager.cancel(groupKey, groupKey.hashCode())
            return
        }
        val summaryShowing = manager.activeNotifications.any {
            it.tag == groupKey && (it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY) != 0
        }
        if (!NotificationSummary.posts(children.size, minChildren, withoutContent, summaryShowing)) return
        val count = children.size
        val countText = NotificationSummary.countText(count, withoutContent)
        val inbox = NotificationCompat.InboxStyle()
        val newestFirst = children.sortedByDescending { it.postTime }.take(NotificationSummary.MAX_LINES).map { sbn ->
            val extras = sbn.notification.extras
            extras.getCharSequence(android.app.Notification.EXTRA_TITLE) to
                extras.getCharSequence(android.app.Notification.EXTRA_TEXT)
        }
        NotificationSummary.lines(newestFirst, withoutContent).forEach { inbox.addLine(it) }
        inbox.setBigContentTitle(groupTitle)
        inbox.setSummaryText(countText)

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
        val summary = NotificationCompat.Builder(ctx, BulwarkMessagingService.channelId(ctx))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(groupTitle)
            .setContentText(countText)
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
        val bgColor = parseColor(bgHex, fallback = Color.parseColor("#2563eb"))
        val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = bgColor
        }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, bgPaint)
        val lum = Color.luminance(bgColor)
        val textColor = if (1.05f / (lum + 0.05f) >= (lum + 0.05f) / 0.05f) Color.WHITE else Color.BLACK
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = textColor
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

        // 1 MiB is plenty for a favicon; anything bigger is a sign of trouble.
        private const val MAX_FAVICON_BYTES = 1 * 1024 * 1024

        @Volatile private var currentInstance: BulwarkFcmModule? = null

        const val EXTRA_ACTION = "bulwark.notification.action"
        const val EXTRA_NOTIFICATION_ID = "bulwark.notification.notificationId"
        const val ACTION_MARK_READ = "com.anonymous.bulwarkmobile.ACTION_MARK_READ"
        const val ACTION_DELETE = "com.anonymous.bulwarkmobile.ACTION_DELETE"
        const val ACTION_ARCHIVE = "com.anonymous.bulwarkmobile.ACTION_ARCHIVE"
        const val ACTION_COPY_CODE = "com.anonymous.bulwarkmobile.ACTION_COPY_CODE"
        const val EXTRA_CODE = "bulwark.notification.code"
        const val EXTRA_CODE_COPIED_LABEL = "bulwark.notification.codeCopiedLabel"

        /**
         * The buttons of a mail notification, in the webmail's order (Copy
         * code, Archive, Mark read, Delete, then Reply). Android shows three:
         * a sign-in mail drops Reply, and past three Mark read goes, since
         * opening the message marks it read too (webmail public/sw.js).
         */
        fun mailActions(hasCode: Boolean, archive: Boolean): List<String> {
            val all = buildList {
                if (hasCode) add("copyCode")
                if (archive) add("archive")
                add("markRead")
                add("delete")
                if (!hasCode) add("reply")
            }
            return if (all.size > 3) all.filter { it != "markRead" }.take(3) else all
        }

        fun emit(eventName: String, params: WritableMap?) {
            val module = currentInstance ?: return
            val ctx = module.reactApplicationContext
            if (!ctx.hasActiveReactInstance()) return
            ctx.getJSModule(RCTDeviceEventEmitter::class.java).emit(eventName, params)
        }

        fun postNotificationNatively(
            context: Context,
            notificationId: String,
            title: String,
            body: String,
            preview: String?,
            initials: String,
            bgColorHex: String,
            iconUrl: String? = null,
            emailId: String?,
            threadId: String?,
            subject: String?,
            accountId: String?,
            jmapAccountId: String?,
            groupKey: String?,
            groupTitle: String?,
            markReadLabel: String = context.getString(R.string.notification_action_mark_read),
            deleteLabel: String = context.getString(R.string.notification_action_delete),
            replyLabel: String = context.getString(R.string.notification_action_reply),
            deleteNeedsUnlock: Boolean = true,
            archiveLabel: String? = null,
            copyCode: NotificationCopyCode? = null,
        ) {
            val largeIcon = iconUrl?.let { fetchBitmap(it) }
                ?: makeLetterAvatar(initials, bgColorHex)
            postNotification(
                context, notificationId, title, body, preview, largeIcon, bgColorHex,
                emailId, threadId, subject, accountId, jmapAccountId, groupKey,
                groupTitle, markReadLabel, deleteLabel, replyLabel, deleteNeedsUnlock,
                archiveLabel, copyCode,
            )
            if (groupKey != null) {
                postGroupSummary(context, groupKey, groupTitle ?: "Bulwark Mail", bgColorHex, accountId)
            }
        }

        /**
         * After notifications of the account were cancelled: posts the group
         * summary again with the new count and lines, keeping its title and
         * colour, or cancels it when no notification is left. A summary posted
         * without lines (the organisation hides notification content) stays
         * without them.
         */
        fun refreshGroupSummaryAfterCancel(ctx: Context, accountId: String) {
            val groupKey = "bulwark-mail:$accountId"
            val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val summary = manager.activeNotifications.firstOrNull {
                it.tag == groupKey &&
                    (it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY) != 0
            } ?: return
            val title = summary.notification.extras
                .getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() ?: accountId
            val colorHex = String.format("#%06X", summary.notification.color and 0xFFFFFF)
            val withoutContent = summary.notification.extras
                .getCharSequenceArray(android.app.Notification.EXTRA_TEXT_LINES).isNullOrEmpty()
            postGroupSummary(ctx, groupKey, title, colorHex, accountId, withoutContent = withoutContent, minChildren = 1)
        }
    }
}

/** A sign-in code to offer for copying from a mail notification, with its labels. */
data class NotificationCopyCode(val code: String, val label: String, val copiedLabel: String)
