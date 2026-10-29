package com.anonymous.bulwarkmobile.sync

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * What a push asks for (#34): syncs of the Android accounts that contacts and
 * calendar changes feed, and whether the mail push task should run at all.
 *
 * The relay forwards the JMAP StateChange's `changed` map verbatim (FCM data
 * key `changed`: JMAP account id → type → state; only its first account is
 * repeated as `accountId`), so every account key is looked at. The mail task
 * runs only for mail: when some account's map has a mail type, for anything
 * but a StateChange (an EmailPush), when `changed` is missing, unreadable or
 * names no type (older relays), or when an account's entry is unreadable, so
 * a contact change never ends in a mail notification. The push task's guard
 * (`carriesNoMail` in src/lib/push-background-task.ts) applies the same rules.
 */
object PushRouting {
    /** An Android account and the authorities it syncs, fed by one JMAP account. */
    data class Route(val accountName: String, val authorities: Set<String>)

    data class Decision(
        /** (Android account name, authority) pairs to request a sync for. */
        val syncs: Set<Pair<String, String>>,
        val startMailTask: Boolean,
    )

    private const val STATE_CHANGE_KIND = "jmap-state-change"

    /**
     * Types that may mean new mail: `EmailDelivery`, and `Email`/`Mailbox`,
     * which new mail changes too. A subscription made by an older build
     * listens to them until the launch-time resync replaces its types, and a
     * server without `EmailDelivery` has only them. Keep in sync with
     * MAIL_TYPES in src/lib/push-background-task.ts.
     */
    private val MAIL_TYPES = setOf("EmailDelivery", "Email", "Mailbox")
    private val CONTACT_TYPES = setOf("ContactCard", "AddressBook")
    private val CALENDAR_TYPES = setOf("CalendarEvent", "Calendar")

    fun decide(data: Map<String, String>, routes: Map<String, List<Route>>): Decision {
        val changed = data["changed"]?.let(::parseChanged)
        // Only a StateChange can say it carries no mail.
        var mail = data["kind"] != STATE_CHANGE_KIND || changed == null
        val syncs = LinkedHashSet<Pair<String, String>>()
        for ((jmapAccountId, types) in changed.orEmpty()) {
            if (types == null) {
                // One account's entry is unreadable: it may be mail.
                mail = true
                continue
            }
            if (types.any { it in MAIL_TYPES }) mail = true
            val contacts = types.any { it in CONTACT_TYPES }
            val calendar = types.any { it in CALENDAR_TYPES }
            for (route in routes[jmapAccountId].orEmpty()) {
                if (contacts && DeviceSyncAccounts.CONTACTS_AUTHORITY in route.authorities) {
                    syncs += route.accountName to DeviceSyncAccounts.CONTACTS_AUTHORITY
                }
                if (calendar && DeviceSyncAccounts.CALENDAR_AUTHORITY in route.authorities) {
                    syncs += route.accountName to DeviceSyncAccounts.CALENDAR_AUTHORITY
                }
            }
        }
        return Decision(syncs, mail)
    }

    /**
     * JMAP account id → its changed types (null for an entry that is not an
     * object). Null for a map that is unreadable or names no type at all,
     * which the relay sends as `{}` when it had no map.
     */
    private fun parseChanged(json: String): Map<String, Set<String>?>? {
        val o = try {
            JSONObject(json)
        } catch (e: JSONException) {
            return null
        }
        val out = LinkedHashMap<String, Set<String>?>()
        for (jmapAccountId in o.keys()) {
            val types = o.opt(jmapAccountId) as? JSONObject
            out[jmapAccountId] = types?.keys()?.asSequence()?.toSet()
        }
        return out.takeIf { entries -> entries.values.any { it == null || it.isNotEmpty() } }
    }

    /**
     * `{ jmapAccountId: [{ accountName, authorities }] }` as JS stores it.
     * [strict] refuses anything malformed (IllegalArgumentException); otherwise
     * malformed entries are skipped, so a bad route never stops mail.
     */
    fun parseRoutes(json: String?, strict: Boolean = false): Map<String, List<Route>> {
        if (json.isNullOrEmpty()) return emptyMap()
        fun bad(message: String): Nothing = throw IllegalArgumentException("Push routes: $message")
        val o = try {
            JSONObject(json)
        } catch (e: JSONException) {
            if (strict) bad("not a JSON object") else return emptyMap()
        }
        val out = LinkedHashMap<String, List<Route>>()
        for (jmapAccountId in o.keys()) {
            val entries = o.opt(jmapAccountId) as? JSONArray
                ?: if (strict) bad("$jmapAccountId must map to an array") else continue
            val routes = ArrayList<Route>()
            for (i in 0 until entries.length()) {
                val entry = entries.opt(i) as? JSONObject
                val name = entry?.opt("accountName") as? String
                val authorities = entry?.opt("authorities") as? JSONArray
                if (name.isNullOrEmpty() || authorities == null) {
                    if (strict) bad("$jmapAccountId[$i] needs accountName and authorities") else continue
                }
                val known = (0 until authorities.length()).mapNotNull { j ->
                    val authority = authorities.opt(j) as? String
                    if (authority !in DeviceSyncAccounts.AUTHORITIES) {
                        if (strict) bad("$jmapAccountId[$i]: unknown authority $authority") else null
                    } else {
                        authority
                    }
                }
                routes += Route(name, known.toSet())
            }
            out[jmapAccountId] = routes
        }
        return out
    }
}

/**
 * Applies [PushRouting] to incoming pushes (BulwarkMessagingService,
 * BulwarkUnifiedPushService) with the routes JS stored through
 * `setPushRoutes`.
 */
object DeviceSyncPushRouter {
    private const val TAG = "BulwarkDeviceSync"
    private const val PREFS = "bulwark_device_sync"
    private const val KEY_ROUTES = "pushRoutes"

    /** Validates and stores the routes; they must survive the process, pushes arrive without JS. */
    fun saveRoutes(context: Context, json: String) {
        PushRouting.parseRoutes(json, strict = true)
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ROUTES, json)
            .commit()
        check(saved) { "Push routes could not be saved" }
    }

    /**
     * Requests the syncs the push asks for, with constant (empty) extras so
     * repeated pushes coalesce into one pending sync. Returns whether the mail
     * push task should run; any failure here says yes, so mail never depends
     * on device sync.
     */
    fun route(context: Context, data: Map<String, String>): Boolean = try {
        val routes = PushRouting.parseRoutes(
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ROUTES, null),
        )
        val decision = PushRouting.decide(data, routes)
        for ((accountName, authority) in decision.syncs) {
            try {
                DeviceSyncAccounts.requestSync(context, accountName, authority, SyncRequestFlags())
            } catch (e: RuntimeException) {
                Log.w(TAG, "Push: no sync requested for $authority", e)
            }
        }
        decision.startMailTask
    } catch (e: Exception) {
        Log.w(TAG, "Push not routed", e)
        true
    }
}
