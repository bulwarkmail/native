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

    // The activity is exported (required by the LAUNCHER intent filter), so
    // any third-party app on the device can craft a starting intent that
    // includes these extras. Reject anything that doesn't look like the IDs
    // our notification builder writes — preventing other apps from
    // navigating us to a forged email/thread.
    private val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,128}$")
    // accountId is `username@host` (see generateAccountId), so it needs `.`,
    // `@`, `+` etc. — cap length and restrict charset to what that helper can
    // emit. accountId is optional: notifications created before this field
    // existed still navigate (using the active account as a fallback).
    private val ACCOUNT_ID_PATTERN = Regex("^[A-Za-z0-9._+@-]{1,256}$")

    fun captureFromIntent(intent: Intent?): TapPayload? {
        val extras = intent?.extras ?: return null
        val emailId = extras.getString(EXTRA_EMAIL_ID)?.takeIf { ID_PATTERN.matches(it) }
            ?: return null
        val threadId = extras.getString(EXTRA_THREAD_ID)?.takeIf { ID_PATTERN.matches(it) }
            ?: return null
        // Subject is human-readable text and may legitimately contain anything;
        // cap its length so a hostile launcher can't ship a 1MB string into
        // the navigation payload.
        val subject = extras.getString(EXTRA_SUBJECT)?.take(512)
        val accountId = extras.getString(EXTRA_ACCOUNT_ID)?.takeIf { ACCOUNT_ID_PATTERN.matches(it) }
        val payload = TapPayload(emailId, threadId, subject, accountId)
        pending = payload
        // Clear so a subsequent activity lifecycle event doesn't replay this.
        extras.remove(EXTRA_EMAIL_ID)
        extras.remove(EXTRA_THREAD_ID)
        extras.remove(EXTRA_SUBJECT)
        extras.remove(EXTRA_ACCOUNT_ID)
        return payload
    }

    data class TapPayload(
        val emailId: String,
        val threadId: String,
        val subject: String?,
        val accountId: String?,
    ) {
        fun toMap(): WritableMap = Arguments.createMap().apply {
            putString("emailId", emailId)
            putString("threadId", threadId)
            if (subject != null) putString("subject", subject)
            if (accountId != null) putString("accountId", accountId)
        }
    }

    const val EXTRA_EMAIL_ID = "bulwark.notification.emailId"
    const val EXTRA_THREAD_ID = "bulwark.notification.threadId"
    const val EXTRA_SUBJECT = "bulwark.notification.subject"
    const val EXTRA_ACCOUNT_ID = "bulwark.notification.accountId"
}
