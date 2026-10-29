package com.anonymous.bulwarkmobile

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the widgets' refresh (BulwarkWidgetRefresh, index.ts) as a headless
 * task when the app goes to the background. Run from the app itself the
 * refresh stalled: React Native pauses JS timers while the activity is in
 * the background, and fetch resolves every response through a timer, so the
 * first request went out and its answer was never read. A running headless
 * task keeps timers going, and the service keeps the process from being
 * frozen before the widgets are redrawn.
 */
class BulwarkWidgetRefreshService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig("BulwarkWidgetRefresh", Arguments.createMap(), 30000L, true)
}
