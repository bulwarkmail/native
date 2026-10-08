package com.anonymous.bulwarkmobile

import android.app.Activity
import android.content.Context
import android.os.Build
import android.view.WindowManager
import androidx.core.view.WindowCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Window-level settings the JS side drives:
 *   - screen protection: FLAG_SECURE ("block screenshots"), and hiding the
 *     recent-apps preview alone (API 33+);
 *   - the status and navigation bar icon colours, which follow the in-app
 *     theme rather than the system night mode.
 *
 * The protection flags are saved on every change, so MainActivity applies
 * them before the first frame of a cold start, before JS has hydrated.
 */
class BulwarkWindowModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = MODULE_NAME

    override fun getConstants(): Map<String, Any> =
        mapOf("supportsRecentsHiding" to supportsRecentsHiding())

    @ReactMethod
    fun setSecure(enabled: Boolean) {
        prefs(reactApplicationContext).edit().putBoolean(PREF_SECURE, enabled).commit()
        onActivity { applySecure(it, enabled) }
    }

    @ReactMethod
    fun setRecentsHidden(enabled: Boolean) {
        prefs(reactApplicationContext).edit().putBoolean(PREF_RECENTS_HIDDEN, enabled).commit()
        onActivity { applyRecentsHidden(it, enabled) }
    }

    @ReactMethod
    fun setSystemBarsAppearance(lightBackground: Boolean) {
        onActivity { activity ->
            val window = activity.window
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = lightBackground
                isAppearanceLightNavigationBars = lightBackground
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
        }
    }

    private fun onActivity(block: (Activity) -> Unit) {
        // ReactContextBaseJavaModule has no Kotlin `currentActivity` property
        // in RN 0.80+.
        val activity: Activity = reactApplicationContext.getCurrentActivity() ?: return
        UiThreadUtil.runOnUiThread { block(activity) }
    }

    companion object {
        const val MODULE_NAME = "BulwarkWindow"
        private const val PREFS_NAME = "bulwark_window"
        private const val PREF_SECURE = "block_screenshots"
        private const val PREF_RECENTS_HIDDEN = "hide_in_recents"

        fun supportsRecentsHiding(): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

        private fun prefs(context: Context) =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        /** Applies the saved protection flags. Called from MainActivity.onCreate. */
        fun applyPersisted(activity: Activity) {
            val prefs = prefs(activity)
            applySecure(activity, prefs.getBoolean(PREF_SECURE, false))
            applyRecentsHidden(activity, prefs.getBoolean(PREF_RECENTS_HIDDEN, false))
        }

        private fun applySecure(activity: Activity, enabled: Boolean) {
            if (enabled) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }

        private fun applyRecentsHidden(activity: Activity, enabled: Boolean) {
            if (supportsRecentsHiding()) activity.setRecentsScreenshotEnabled(!enabled)
        }
    }
}
