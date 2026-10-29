package com.anonymous.bulwarkmobile

import android.content.Intent
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** JS side: src/widgets/sync.ts. */
class BulwarkWidgetsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BulwarkWidgets"

    /** Starts BulwarkWidgetRefreshService; resolves false when Android refuses the start. */
    @ReactMethod
    fun refreshInBackground(promise: Promise) {
        try {
            reactApplicationContext.startService(Intent(reactApplicationContext, BulwarkWidgetRefreshService::class.java))
            promise.resolve(true)
        } catch (e: IllegalStateException) {
            // Background start limits (the app left the foreground too long ago).
            promise.resolve(false)
        } catch (e: SecurityException) {
            promise.resolve(false)
        }
    }
}
