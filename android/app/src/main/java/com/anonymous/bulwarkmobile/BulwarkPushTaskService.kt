package com.anonymous.bulwarkmobile

import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.HeadlessJsTaskService

class BulwarkPushTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras ?: return null
        return HeadlessJsTaskConfig(
            "BulwarkPushTask",
            Arguments.fromBundle(extras),
            30000L,
            false,
        )
    }
}
