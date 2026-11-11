package com.anonymous.bulwarkmobile

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles incoming mail push notifications directly in native Kotlin.
 *
 * This mirrors the iOS NotificationService.swift / Jmap.swift implementation:
 * it fetches message metadata (sender, subject, preview) over JMAP using
 * credentials stored securely by the app, and displays the notification immediately
 * without booting React Native or Hermes.
 *
 * This completely avoids the background freeze on Samsung devices (One UI)
 * and aggressive battery optimizers where Choreographer frame callbacks and
 * JavaScript timers are suspended in the background (#94).
 */
object BulwarkNativePushFetcher {
    private const val TAG = "BulwarkNativePush"
    const val PREFS_NAME = "bulwark_native_push_accounts"
    private const val NOTIFIED_IDS_LIMIT = 200

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    data class PushedEmail(
        val id: String,
        val threadId: String,
        val sender: String,
        val subject: String,
        val preview: String
    )

    data class FreshTokens(
        val accessToken: String,
        val refreshToken: String?,
        val expiresIn: Double
    )

    /**
     * Returns hardware-backed EncryptedSharedPreferences (Android Keystore),
     * or standard SharedPreferences as fallback if Keystore initialization fails.
     */
    fun getPrefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            Log.w(TAG, "EncryptedSharedPreferences init failed, falling back to standard prefs", e)
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    private fun isAlreadyNotified(prefs: SharedPreferences, accountId: String, emailId: String): Boolean {
        val raw = prefs.getString("notified_ids_$accountId", null) ?: return false
        return try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                if (arr.optString(i) == emailId) return true
            }
            false
        } catch (_: Exception) {
            false
        }
    }

    private fun rememberNotifiedIds(prefs: SharedPreferences, accountId: String, newIds: List<String>) {
        if (newIds.isEmpty()) return
        try {
            val current = mutableListOf<String>()
            val raw = prefs.getString("notified_ids_$accountId", null)
            if (raw != null) {
                val arr = JSONArray(raw)
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i)
                    if (id.isNotBlank()) current.add(id)
                }
            }
            val combined = (newIds + current.filter { !newIds.contains(it) }).take(NOTIFIED_IDS_LIMIT)
            val json = JSONArray()
            combined.forEach { json.put(it) }
            prefs.edit().putString("notified_ids_$accountId", json.toString()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to persist notified IDs for $accountId", e)
        }
    }

    /**
     * Attempts to fetch new mail metadata and post notifications natively.
     * Returns true if successfully handled (or confirmed nothing to notify),
     * or false if fallback to the headless JS task is required.
     */
    fun processPush(context: Context, data: Map<String, String>): Boolean {
        return try {
            val jmapAccountId = data["accountId"]?.takeIf { it.isNotBlank() } ?: return false
            val prefs = getPrefs(context)
            val accountRaw = prefs.getString(jmapAccountId, null) ?: return false

            val account = JSONObject(accountRaw)

            // Respect user notification permissions/preferences
            val notificationsAllowed = account.optBoolean("notificationsAllowed", true)
            if (!notificationsAllowed) {
                Log.i(TAG, "Push received but email notifications disabled for account $jmapAccountId")
                return true
            }

            val apiUrl = account.optString("apiUrl").takeIf { it.isNotBlank() } ?: return false
            val localAccountId = account.optString("accountId", jmapAccountId)
            val label = account.optString("label").takeIf { it.isNotBlank() }
            val username = account.optString("username").takeIf { it.isNotBlank() }
            val password = account.optString("password").takeIf { it.isNotBlank() }
            var accessToken = account.optString("accessToken").takeIf { it.isNotBlank() }
            val refreshToken = account.optString("refreshToken").takeIf { it.isNotBlank() }
            val tokenEndpoint = account.optString("tokenEndpoint").takeIf { it.isNotBlank() }
            val clientId = account.optString("clientId").takeIf { it.isNotBlank() }
            var expiresAt = account.optLong("expiresAt", 0L)

            // Validate push label if present (mirroring NotificationService.swift)
            val pushLabel = data["accountLabel"]
            if (!pushLabel.isNullOrBlank() && label != null && !pushLabel.equals(label, ignoreCase = true)) {
                Log.w(TAG, "Push label does not fit shared account for $jmapAccountId ($pushLabel vs $label)")
                return false
            }

            // Resolve email IDs
            val rawEmailIds = mutableListOf<String>()
            val rawEmailIdsStr = data["emailIds"]
            if (!rawEmailIdsStr.isNullOrBlank()) {
                try {
                    val arr = JSONArray(rawEmailIdsStr)
                    for (i in 0 until arr.length()) {
                        val id = arr.optString(i)
                        if (id.isNotBlank()) rawEmailIds.add(id)
                    }
                } catch (_: Exception) {}
            }
            if (rawEmailIds.isEmpty() && !data["emailId"].isNullOrBlank()) {
                rawEmailIds.add(data["emailId"]!!)
            }

            // If the push carries no explicit email IDs (e.g. legacy state-change without IDs),
            // return false to let the headless JS task perform the full mailbox/query resolution.
            if (rawEmailIds.isEmpty()) {
                Log.i(TAG, "Push has no emailIds; falling back to headless JS task")
                return false
            }

            // Deduplication: filter out already notified email IDs
            val freshEmailIds = rawEmailIds.filter { !isAlreadyNotified(prefs, localAccountId, it) }
            if (freshEmailIds.isEmpty()) {
                Log.i(TAG, "All email IDs already notified for account $localAccountId; skipping")
                return true
            }

            // Authorization header
            val authHeader = if (accessToken != null) {
                val now = System.currentTimeMillis()
                if (expiresAt > 0 && expiresAt - now < 60_000 && refreshToken != null && tokenEndpoint != null) {
                    val fresh = refreshOAuthToken(tokenEndpoint, refreshToken, clientId)
                    if (fresh != null) {
                        accessToken = fresh.accessToken
                        expiresAt = now + (fresh.expiresIn * 1000).toLong()
                        account.put("accessToken", fresh.accessToken)
                        if (fresh.refreshToken != null) account.put("refreshToken", fresh.refreshToken)
                        account.put("expiresAt", expiresAt)
                        account.put("tokensRefreshed", true)
                        prefs.edit().putString(jmapAccountId, account.toString()).apply()
                    }
                }
                "Bearer $accessToken"
            } else if (username != null && password != null) {
                val basic = Base64.encodeToString(
                    "$username:$password".toByteArray(Charsets.UTF_8),
                    Base64.NO_WRAP
                )
                "Basic $basic"
            } else {
                return false
            }

            // Construct JMAP Email/get call
            val idsJson = JSONArray()
            freshEmailIds.take(5).forEach { idsJson.put(it) }

            val props = JSONArray().apply {
                put("threadId")
                put("from")
                put("subject")
                put("preview")
                put("keywords")
                put("receivedAt")
            }
            val args = JSONObject().apply {
                put("accountId", jmapAccountId)
                put("ids", idsJson)
                put("properties", props)
            }

            val methodCalls = JSONArray().apply {
                put(JSONArray().apply {
                    put("Email/get")
                    put(args)
                    put("0")
                })
            }

            val bodyJson = JSONObject().apply {
                put("using", JSONArray().apply {
                    put("urn:ietf:params:jmap:core")
                    put("urn:ietf:params:jmap:mail")
                })
                put("methodCalls", methodCalls)
            }

            val request = Request.Builder()
                .url(apiUrl)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .addHeader("Authorization", authHeader)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.w(TAG, "JMAP HTTP request failed with code ${response.code}")
                return false
            }

            val responseBody = response.body?.string() ?: return false
            val root = JSONObject(responseBody)
            val methodResponses = root.optJSONArray("methodResponses") ?: return false

            val emails = mutableListOf<PushedEmail>()
            for (i in 0 until methodResponses.length()) {
                val resp = methodResponses.optJSONArray(i) ?: continue
                val name = resp.optString(0)
                val methodArgs = resp.optJSONObject(1) ?: continue
                if (name == "Email/get") {
                    val list = methodArgs.optJSONArray("list") ?: continue
                    for (j in 0 until list.length()) {
                        val email = list.optJSONObject(j) ?: continue
                        val id = email.optString("id")
                        val keywords = email.optJSONObject("keywords")
                        if (keywords?.optBoolean("\$seen", false) == true ||
                            keywords?.optBoolean("\$junk", false) == true) {
                            continue
                        }
                        val threadId = email.optString("threadId")
                        val subject = email.optString("subject", "")
                        val preview = email.optString("preview", "")

                        val fromArr = email.optJSONArray("from")
                        val fromObj = fromArr?.optJSONObject(0)
                        val senderName = fromObj?.optString("name")?.takeIf { it.isNotBlank() }
                        val senderEmail = fromObj?.optString("email")?.takeIf { it.isNotBlank() }
                        val sender = senderName ?: senderEmail ?: label ?: "New mail"

                        emails.add(PushedEmail(id, threadId, sender, subject, preview))
                    }
                }
            }

            if (emails.isEmpty()) {
                Log.i(TAG, "Native push: no unread messages found; letting headless task inspect fallback")
                return false
            }

            // Post notification for the unread emails
            val groupKey = "bulwark-mail:$localAccountId"
            val groupTitle = label ?: localAccountId
            val noSubjectText = context.getString(R.string.notification_no_subject)

            for (email in emails) {
                val displaySubject = if (email.subject.isNotBlank()) email.subject else noSubjectText
                BulwarkFcmModule.postNotificationNatively(
                    context = context,
                    notificationId = "mail:${email.id}",
                    title = email.sender,
                    body = displaySubject,
                    preview = email.preview,
                    emailId = email.id,
                    threadId = email.threadId,
                    subject = displaySubject,
                    accountId = localAccountId,
                    jmapAccountId = jmapAccountId,
                    groupKey = groupKey,
                    groupTitle = groupTitle,
                    deleteNeedsUnlock = false
                )
            }

            rememberNotifiedIds(prefs, localAccountId, emails.map { it.id })
            Log.i(TAG, "Native push: successfully posted ${emails.size} notification(s)")
            true
        } catch (e: Exception) {
            Log.w(TAG, "processPush exception: ${e.message}", e)
            false
        }
    }

    private fun refreshOAuthToken(tokenEndpoint: String, refreshToken: String, clientId: String?): FreshTokens? {
        return try {
            val form = FormBody.Builder()
                .add("grant_type", "refresh_token")
                .add("refresh_token", refreshToken)
            if (!clientId.isNullOrBlank()) form.add("client_id", clientId)

            val req = Request.Builder()
                .url(tokenEndpoint)
                .addHeader("Accept", "application/json")
                .post(form.build())
                .build()

            val resp = httpClient.newCall(req).execute()
            if (!resp.isSuccessful) return null
            val body = JSONObject(resp.body?.string() ?: return null)
            val accessToken = body.optString("access_token").takeIf { it.isNotBlank() } ?: return null
            val newRefresh = body.optString("refresh_token").takeIf { it.isNotBlank() }
            val expiresIn = body.optDouble("expires_in", 3600.0)
            FreshTokens(accessToken, newRefresh, expiresIn)
        } catch (_: Exception) {
            null
        }
    }
}
