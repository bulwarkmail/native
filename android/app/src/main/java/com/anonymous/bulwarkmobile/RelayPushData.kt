package com.anonymous.bulwarkmobile

import com.anonymous.bulwarkmobile.sync.PushRouting
import org.json.JSONException
import org.json.JSONObject

/**
 * The push data every transport hands on: the flat string map of the relay's
 * FCM data (repos/relay/src/fcm.ts). UnifiedPush flattens the relay's JSON
 * into it and the direct connection builds it from the server's StateChange,
 * so the push task and the device sync routing serve all three unchanged.
 */
object RelayPushData {
    /** The map; [kind], [accountLabel] and [accountId] are left out when empty, [changed] when null. */
    fun of(kind: String?, accountLabel: String?, accountId: String?, emailIds: String, changed: String?): Map<String, String> =
        buildMap {
            kind?.takeIf { it.isNotEmpty() }?.let { put("kind", it) }
            accountLabel?.takeIf { it.isNotEmpty() }?.let { put("accountLabel", it) }
            accountId?.takeIf { it.isNotEmpty() }?.let { put("accountId", it) }
            put("emailIds", emailIds)
            changed?.let { put("changed", it) }
        }

    /**
     * The push a JMAP StateChange (RFC 8620 §7.1) read from an event stream
     * becomes: one, with its whole `changed` map and no `accountId`, as the
     * relay sends one without ids, which has the push task look at the newest
     * unread inbox mail and notify what it has not notified before. One push
     * per event: the task looks once, whatever the number of accounts named.
     * [accountLabel] is the username of the login the stream belongs to; it
     * tells the push task which local account to look at. Null for anything
     * that is not a StateChange, or one that names no account.
     */
    fun ofStateChange(data: String, accountLabel: String?): Map<String, String>? {
        val changed = try {
            val json = JSONObject(data)
            if (json.optString("@type") != "StateChange") return null
            json.optJSONObject("changed") ?: return null
        } catch (_: JSONException) {
            return null
        }
        if (changed.length() == 0) return null
        return of(PushRouting.STATE_CHANGE_KIND, accountLabel, null, NO_EMAIL_IDS, changed.toString())
    }

    /**
     * The push for a stream that went live, when nothing says what changed:
     * without `changed`, so the task takes it for mail and the device sync is
     * not woken (PushRouting.decide).
     */
    fun catchUp(accountLabel: String?): Map<String, String> =
        of(PushRouting.STATE_CHANGE_KIND, accountLabel, null, NO_EMAIL_IDS, null)

    private const val NO_EMAIL_IDS = "[]"
}
