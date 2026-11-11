package com.anonymous.bulwarkmobile

import android.content.Context
import android.util.Base64
import android.util.Log
import okhttp3.FormBody
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles incoming mail push notifications directly in native Kotlin.
 *
 * This mirrors the iOS NotificationService.swift / Jmap.swift implementation:
 * it fetches message metadata (sender, subject, preview) over JMAP using
 * credentials stored by the app, and displays the notification immediately
 * without booting React Native or Hermes.
 *
 * This completely avoids the background freeze on Samsung devices (One UI)
 * and aggressive battery optimizers where Choreographer frame callbacks and
 * JavaScript timers are suspended in the background (#94).
 */
object BulwarkNativePushFetcher {
    private const val TAG = "BulwarkNativePush"
    const val PREFS_NAME = "bulwark_native_push_accounts"

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA_TYPE = MediaType.parse("application/json; charset=utf-8")

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
     * Attempts to fetch new mail metadata and post notifications natively.
     * Returns true if successfully handled (or confirmed nothing to notify),
     * or false if fallback to the headless JS task is required.
     */
    fun processPush(context: Context, data: Map<String, String>): Boolean {
        return try {
            val jmapAccountId = data["accountId"]?.takeIf { it.isNotBlank() } ?: return false
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val accountRaw = prefs.getString(jmapAccountId, null) ?: return false

            val account = JSONObject(accountRaw)
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
            val emailIds = mutableListOf<String>()
            val rawEmailIds = data["emailIds"]
            if (!rawEmailIds.isNullOrBlank()) {
                try {
                    val arr = JSONArray(rawEmailIds)
                    for (i in 0 until arr.length()) {
                        val id = arr.optString(i)
                        if (id.isNotBlank()) emailIds.add(id)
                    }
                } catch (_: Exception) {}
            }
            if (emailIds.isEmpty() && !data["emailId"].isNullOrBlank()) {
                emailIds.add(data["emailId"]!!)
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

            // Construct JMAP method calls
            val methodCalls = JSONArray()
            if (emailIds.isNotEmpty()) {
                val idsJson = JSONArray()
                emailIds.take(5).forEach { idsJson.put(it) }

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
                methodCalls.put(JSONArray().apply {
                    put("Email/get")
                    put(args)
                    put("0")
                })
            } else {
                // Fallback for jmap-state-change: query newest unread in inbox
                methodCalls.put(JSONArray().apply {
                    put("Mailbox/query")
                    put(JSONObject().apply {
                        put("accountId", jmapAccountId)
                        put("filter", JSONObject().apply { put("role", "inbox") })
                    })
                    put("0")
                })
                methodCalls.put(JSONArray().apply {
                    put("Email/query")
                    put(JSONObject().apply {
                        put("accountId", jmapAccountId)
                        put("#inMailbox", JSONObject().apply {
                            put("resultOf", "0")
                            put("name", "Mailbox/query")
                            put("path", "/ids/0")
                        })
                        put("filter", JSONObject().apply { put("notKeyword", "\$seen") })
                        put("sort", JSONArray().apply {
                            put(JSONObject().apply {
                                put("property", "receivedAt")
                                put("isAscending", false)
                            })
                        })
                        put("limit", 5)
                    })
                    put("1")
                })
                methodCalls.put(JSONArray().apply {
                    put("Email/get")
                    put(JSONObject().apply {
                        put("accountId", jmapAccountId)
                        put("#ids", JSONObject().apply {
                            put("resultOf", "1")
                            put("name", "Email/query")
                            put("path", "/ids")
                        })
                        put("properties", JSONArray().apply {
                            put("threadId")
                            put("from")
                            put("subject")
                            put("preview")
                            put("keywords")
                            put("receivedAt")
                        })
                    })
                    put("2")
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
                .post(RequestBody.create(JSON_MEDIA_TYPE, bodyJson.toString()))
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.w(TAG, "JMAP HTTP request failed with code ${response.code()}")
                return false
            }

            val responseBody = response.body()?.string() ?: return false
            val root = JSONObject(responseBody)
            val methodResponses = root.optJSONArray("methodResponses") ?: return false

            val emails = mutableListOf<PushedEmail>()
            for (i in 0 until methodResponses.length()) {
                val resp = methodResponses.optJSONArray(i) ?: continue
                val name = resp.optString(0)
                val args = resp.optJSONObject(1) ?: continue
                if (name == "Email/get") {
                    val list = args.optJSONArray("list") ?: continue
                    for (j in 0 until list.length()) {
                        val email = list.optJSONObject(j) ?: continue
                        val id = email.optString("id")
                        val keywords = email.optJSONObject("keywords")
                        if (keywords?.optBoolean("\$seen", false) == true ||
                            keywords?.optBoolean("\$junk", false) == true) {
                            continue
                        }
                        val threadId = email.optString("threadId")
                        val subject = email.optString("subject", "").ifEmpty { "(no subject)" }
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
                Log.i(TAG, "Native push: no unread messages to notify")
                return true
            }

            // Post notification for the unread emails
            val groupKey = "bulwark-mail:$localAccountId"
            val groupTitle = label ?: localAccountId

            for (email in emails) {
                BulwarkFcmModule.postNotificationNatively(
                    context = context,
                    notificationId = "mail:${email.id}",
                    title = email.sender,
                    body = email.sender,
                    preview = if (email.subject.isNotBlank()) "${email.subject}\n${email.preview}".trim() else email.preview,
                    emailId = email.id,
                    threadId = email.threadId,
                    subject = email.subject,
                    accountId = localAccountId,
                    jmapAccountId = jmapAccountId,
                    groupKey = groupKey,
                    groupTitle = groupTitle,
                    deleteNeedsUnlock = false
                )
            }
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
            val body = JSONObject(resp.body()?.string() ?: return null)
            val accessToken = body.optString("access_token").takeIf { it.isNotBlank() } ?: return null
            val newRefresh = body.optString("refresh_token").takeIf { it.isNotBlank() }
            val expiresIn = body.optDouble("expires_in", 3600.0)
            FreshTokens(accessToken, newRefresh, expiresIn)
        } catch (_: Exception) {
            null
        }
    }
}
