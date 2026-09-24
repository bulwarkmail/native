package com.anonymous.bulwarkmobile

import android.content.Intent
import android.os.Bundle
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.HeadlessJsTaskService

class BulwarkPushTaskService : HeadlessJsTaskService() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        super.onStartCommand(intent, flags, startId).also {
            // startTask has taken React Native's wake lock by now.
            BulwarkMessagingService.releaseStartWakeLock()
        }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras ?: return null
        return taskConfig(extras)
    }

    companion object {
        // Shared with BulwarkPushJobService, which runs the same task when
        // this service may not be started.
        fun taskConfig(extras: Bundle): HeadlessJsTaskConfig =
            HeadlessJsTaskConfig(
                "BulwarkPushTask",
                Arguments.fromBundle(extras),
                30000L,
                false,
            )
    }
}
