package com.anonymous.bulwarkmobile

import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

// Process-wide holder for the most recent notification tap. MainActivity fills
// this on onCreate / onNewIntent; JS drains it via BulwarkFcm.getInitialNotification
// or reacts to the live "fcm:notificationTap" event.
object NotificationTapStore {
    @Volatile
    private var pending: TapPayload? = null

    fun consume(): TapPayload? {
        val value = pending
        pending = null
        return value
    }

    fun captureFromIntent(intent: Intent?): TapPayload? {
        val extras = intent?.extras ?: return null
        val emailId = extras.getString(EXTRA_EMAIL_ID) ?: return null
        val threadId = extras.getString(EXTRA_THREAD_ID) ?: return null
        val subject = extras.getString(EXTRA_SUBJECT)
        val payload = TapPayload(emailId, threadId, subject)
        pending = payload
        // Clear so a subsequent activity lifecycle event doesn't replay this.
        extras.remove(EXTRA_EMAIL_ID)
        extras.remove(EXTRA_THREAD_ID)
        extras.remove(EXTRA_SUBJECT)
        return payload
    }

    data class TapPayload(
        val emailId: String,
        val threadId: String,
        val subject: String?,
    ) {
        fun toMap(): WritableMap = Arguments.createMap().apply {
            putString("emailId", emailId)
            putString("threadId", threadId)
            if (subject != null) putString("subject", subject)
        }
    }

    const val EXTRA_EMAIL_ID = "bulwark.notification.emailId"
    const val EXTRA_THREAD_ID = "bulwark.notification.threadId"
    const val EXTRA_SUBJECT = "bulwark.notification.subject"
}
