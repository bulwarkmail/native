package com.anonymous.bulwarkmobile

import android.content.Context
import com.facebook.react.bridge.Arguments
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

// Receives UnifiedPush events from the user's distributor app (ntfy, ...).
// The relay sends the same content-blind ForwardPayload it sends over FCM -
// as encrypted Web Push when the connector provided RFC 8291 keys (the
// connector decrypts before this service sees it) - so an incoming message is
// dispatched exactly like an FCM data message: headless task when the app is
// backgrounded, `fcm:message` device event for the live JS instance.
class BulwarkUnifiedPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        saveEndpoint(this, endpoint)
        val params = Arguments.createMap().apply {
            putString("url", endpoint.url)
            putString("p256dh", endpoint.pubKeySet?.pubKey)
            putString("auth", endpoint.pubKeySet?.auth)
        }
        BulwarkFcmModule.emit("up:newEndpoint", params)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        BulwarkMessagingService.ensureChannel(this)
        val data = parsePayload(message.content) ?: return

        if (!BulwarkMessagingService.isAppInForeground()) {
            BulwarkMessagingService.startHeadlessTask(applicationContext, data)
        }

        // Same event name and shape as the FCM path so the foreground JS
        // handler (App.tsx addMessageListener) works transport-agnostically.
        val params = Arguments.createMap().apply {
            val dataMap = Arguments.createMap()
            for ((k, v) in data) dataMap.putString(k, v)
            putMap("data", dataMap)
        }
        BulwarkFcmModule.emit("fcm:message", params)
    }

    override fun onUnregistered(instance: String) {
        clearEndpoint(this)
        BulwarkFcmModule.emit("up:unregistered", Arguments.createMap())
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        val params = Arguments.createMap().apply { putString("reason", reason.name) }
        BulwarkFcmModule.emit("up:registrationFailed", params)
    }

    companion object {
        private const val PREFS = "bulwark_unifiedpush"
        private const val KEY_URL = "endpointUrl"
        private const val KEY_P256DH = "endpointP256dh"
        private const val KEY_AUTH = "endpointAuth"

        // The endpoint arrives asynchronously (possibly while no JS instance
        // is alive), so persist it for BulwarkUnifiedPushModule.getEndpoint.
        fun saveEndpoint(context: Context, endpoint: PushEndpoint) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_URL, endpoint.url)
                .putString(KEY_P256DH, endpoint.pubKeySet?.pubKey)
                .putString(KEY_AUTH, endpoint.pubKeySet?.auth)
                .apply()
        }

        fun readEndpoint(context: Context): Triple<String, String?, String?>? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = prefs.getString(KEY_URL, null) ?: return null
            return Triple(url, prefs.getString(KEY_P256DH, null), prefs.getString(KEY_AUTH, null))
        }

        fun clearEndpoint(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }

        // The relay's ForwardPayload JSON, flattened to the string map the
        // FCM data payload uses (repos/relay/src/fcm.ts) so the headless task
        // and foreground handler can stay transport-blind.
        fun parsePayload(content: ByteArray): Map<String, String>? = try {
            val json = JSONObject(String(content, Charsets.UTF_8))
            buildMap {
                json.optString("kind").takeIf { it.isNotEmpty() }?.let { put("kind", it) }
                json.optString("accountLabel").takeIf { it.isNotEmpty() }?.let { put("accountLabel", it) }
                json.optString("accountId").takeIf { it.isNotEmpty() }?.let { put("accountId", it) }
                put("emailIds", (json.optJSONArray("emailIds") ?: JSONArray()).toString())
                put("changed", (json.optJSONObject("changed") ?: JSONObject()).toString())
            }
        } catch (_: Exception) {
            null
        }
    }
}
