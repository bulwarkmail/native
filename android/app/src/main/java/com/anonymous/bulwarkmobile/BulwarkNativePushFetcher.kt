package com.anonymous.bulwarkmobile

import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.util.Log
import com.reactnativecommunity.asyncstorage.AsyncLocalStorageUtil
import com.reactnativecommunity.asyncstorage.ReactDatabaseSupplier
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Handles incoming mail push notifications directly in native Kotlin.
 *
 * Mirrors the iOS NotificationService.swift / Jmap.swift / SharedKeychain.swift
 * architecture and shares the exact same credential and deduplication stores as JS:
 * 1. Credentials are read from (and refreshed OAuth tokens are written back to)
 *    expo-secure-store's "SecureStore" SharedPreferences encrypted with AndroidKeyStore
 *    AES/GCM/NoPadding under `credentialsKey(accountId)` — zero duplicate credential copies,
 *    zero plaintext storage, and zero token drift window with `jmapClient.adoptStoredTokens()`.
 * 2. Deduplication (`push:notifiedIds:v1:<accountId>` and `push:lastNotifiedEmailId:v2:<accountId>`)
 *    and settings (`webmail:settings:v1`, `push:optedOut:v1:<accountId>`) are read from and
 *    written to AsyncStorage's `RKStorage` SQLite database (`catalystLocalStorage`).
 *
 * This completely avoids the background freeze on Samsung devices (One UI)
 * and aggressive battery optimizers where Choreographer frame callbacks and
 * JavaScript timers are suspended in the background (#94).
 */
object BulwarkNativePushFetcher {
    private const val TAG = "BulwarkNativePush"
    const val PREFS_NAME = "bulwark_native_push_accounts"
    const val NOTIFIED_IDS_LIMIT = 200
    private const val TOKEN_REFRESH_LEEWAY_MS = 60_000L

    // Expo SecureStore constants (must match expo.modules.securestore.SecureStoreModule & AESEncryptor)
    private const val SECURE_STORE_PREFS_NAME = "SecureStore"
    private const val ANDROID_KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val AES_CIPHER = "AES/GCM/NoPadding"
    private const val DEFAULT_KEYSTORE_ALIAS = "key_v1"
    private const val UNAUTHENTICATED_KEYSTORE_SUFFIX = "keystoreUnauthenticated"
    private const val MIN_GCM_TAG_LENGTH_BITS = 96

    // AsyncStorage key constants (must match src/lib/push-notifications.ts & src/lib/push-background-task.ts)
    const val SETTINGS_STORAGE_KEY = "webmail:settings:v1"
    private const val NOTIFIED_IDS_PREFIX = "push:notifiedIds:v1:"
    private const val LAST_NOTIFIED_EMAIL_ID_PREFIX = "push:lastNotifiedEmailId:v2:"
    private const val OPTED_OUT_PREFIX = "push:optedOut:v1:"
    private const val CREDENTIALS_PREFIX = "jmap_credentials__"
    private const val SUBSCRIPTION_ID_PREFIX = "push:subscriptionId:v2:"
    private const val SUBSCRIPTION_EXPIRES_PREFIX = "push:subscriptionExpires:v1:"
    /** BACKGROUND_EXTEND_BELOW_MS in src/lib/push-notifications.ts. */
    private const val EXTEND_SUBSCRIPTION_BELOW_MS = 6L * 24 * 60 * 60 * 1000

    private val secureStoreLock = Any()
    // Held across a token refresh, so two native refreshes (a push and a
    // notification action) never spend the same refresh token.
    private val refreshLock = Any()

    /**
     * How long a push may spend on the network here. Android gives the FCM
     * service little time, and when the native lookup fails the JS task still
     * has to start: a refresh, the lookup and a 401 retry at 10 s each could
     * outlast the process, leaving no notification and no fallback.
     */
    const val PUSH_BUDGET_MS = 8_000L
    /** A notification action's budget; the receiver gives up after 20 s. */
    private const val ACTION_BUDGET_MS = 15_000L
    /** Sender icons are fetched only with this much of the budget left (3 s connect + 3 s read). */
    const val FAVICON_MIN_LEFT_MS = 6_000L

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    // The refresh token goes in the body: a redirect must not carry it to
    // another host (the app's refresh refuses foreign redirects too).
    private val tokenClient = httpClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** Runs [request], giving up at [deadlineMs]. */
    internal inline fun <T> executeBefore(
        client: OkHttpClient,
        request: Request,
        deadlineMs: Long,
        block: (Response) -> T,
    ): T {
        val left = deadlineMs - System.currentTimeMillis()
        if (left <= 0) throw IOException("No time left for ${request.url.host}")
        val call = client.newCall(request)
        call.timeout().timeout(left, TimeUnit.MILLISECONDS)
        return call.execute().use(block)
    }

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    data class PushedEmail(
        val id: String,
        val threadId: String,
        val senderName: String,
        val senderEmail: String,
        val subject: String,
        val preview: String,
        val receivedAtEpochMs: Long,
    )

    data class StoredCredentials(
        val rawJson: JSONObject,
        val serverUrl: String,
        val username: String,
        val password: String?,
        val accessToken: String?,
        val refreshToken: String?,
        val expiresAt: Long,
        val tokenEndpoint: String?,
        val clientId: String?,
    )

    data class FreshTokens(
        val accessToken: String,
        val refreshToken: String?,
        val expiresIn: Double,
    )

    data class LocalizedStrings(
        val newEmail: String,
        val noSubject: String,
        val markRead: String,
        val delete: String,
        val reply: String,
    )

    sealed class JmapFetchResult {
        data class Success(val emails: List<PushedEmail>, val hasTrash: Boolean) : JmapFetchResult()
        data class Failure(val reason: String) : JmapFetchResult()
    }

    /**
     * Non-sensitive routing metadata per JMAP account ID:
     * `{ credentialsKey, accountId, apiUrl, label, strings }`.
     * Passwords and OAuth tokens are never stored here; they remain solely in Expo SecureStore.
     */
    fun getPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Removes shared push metadata by either `jmapAccountId` (map key) or `localAccountId`
     * (`accountId` field inside the JSON value).
     */
    fun removePushAccount(context: Context, idOrAccountId: String) {
        if (idOrAccountId.isBlank()) return
        val prefs = getPrefs(context)
        val editor = prefs.edit()
        editor.remove(idOrAccountId)
        for ((key, value) in prefs.all) {
            val raw = value as? String ?: continue
            val matchesAccount = try {
                JSONObject(raw).optString("accountId") == idOrAccountId
            } catch (_: Exception) {
                false
            }
            if (matchesAccount) editor.remove(key)
        }
        editor.apply()
    }

    // ─── Pure key & data helpers (JVM-unit-testable) ────────────────────────

    fun credentialsKeyFor(accountId: String): String =
        CREDENTIALS_PREFIX + accountId.replace(Regex("[^a-zA-Z0-9._-]"), "_")

    fun notifiedIdsKeyFor(accountId: String): String =
        NOTIFIED_IDS_PREFIX + accountId

    fun lastNotifiedKeyFor(accountId: String): String =
        LAST_NOTIFIED_EMAIL_ID_PREFIX + accountId

    fun optedOutKeyFor(accountId: String): String =
        OPTED_OUT_PREFIX + accountId

    fun parseNotifiedIds(notifiedIdsJson: String?, legacyLastNotifiedId: String?): List<String> {
        if (!notifiedIdsJson.isNullOrBlank()) {
            try {
                val arr = JSONArray(notifiedIdsJson)
                val out = mutableListOf<String>()
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i)
                    if (id.isNotBlank()) out.add(id)
                }
                return out
            } catch (_: Exception) {
                // Fall through to legacy key
            }
        }
        return if (!legacyLastNotifiedId.isNullOrBlank()) listOf(legacyLastNotifiedId) else emptyList()
    }

    fun mergeNotifiedIds(
        current: List<String>,
        newIds: List<String>,
        limit: Int = NOTIFIED_IDS_LIMIT,
    ): List<String> {
        if (newIds.isEmpty()) return current.take(limit)
        val newSet = newIds.toSet()
        return (newIds + current.filter { !newSet.contains(it) }).take(limit)
    }

    fun extractEmailIds(data: Map<String, String>): List<String> {
        val out = mutableListOf<String>()
        val rawEmailIdsStr = data["emailIds"]
        if (!rawEmailIdsStr.isNullOrBlank()) {
            try {
                val arr = JSONArray(rawEmailIdsStr)
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i)
                    if (id.isNotBlank()) out.add(id)
                }
            } catch (_: Exception) {}
        }
        if (out.isEmpty()) {
            val single = data["emailId"]
            if (!single.isNullOrBlank()) out.add(single)
        }
        return out
    }

    fun isEmailNotificationsEnabledInSettings(settingsJson: String?): Boolean {
        if (settingsJson.isNullOrBlank()) return true
        return try {
            val obj = JSONObject(settingsJson)
            if (obj.has("emailNotificationsEnabled") && !obj.isNull("emailNotificationsEnabled")) {
                obj.optBoolean("emailNotificationsEnabled", true)
            } else {
                true
            }
        } catch (_: Exception) {
            true
        }
    }

    fun isSenderFaviconsEnabledInSettings(settingsJson: String?): Boolean {
        if (settingsJson.isNullOrBlank()) return false
        return try {
            JSONObject(settingsJson).optBoolean("senderFavicons", false)
        } catch (_: Exception) {
            false
        }
    }

    fun isDeleteMarksReadInSettings(settingsJson: String?): Boolean {
        if (settingsJson.isNullOrBlank()) return false
        return try {
            JSONObject(settingsJson).optString("deleteAction") == "trash-and-read"
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Whether a push's `accountLabel` fits the shared account entry.
     * Mirrors `NotificationService.swift` and `accountMatchesPushLabel` in `push-notifications.ts`.
     */
    fun pushLabelMatchesAccount(pushLabel: String?, accountLabel: String?, localAccountId: String): Boolean {
        if (pushLabel.isNullOrBlank()) return true
        val wanted = pushLabel.trim().lowercase()
        if (!accountLabel.isNullOrBlank()) {
            return accountLabel.trim().lowercase() == wanted
        }
        return localAccountId.trim().lowercase().startsWith("$wanted@")
    }

    // ─── Text Sanitization (mirrors src/lib/single-line.ts & src/lib/preview-text.ts) ──

    private val WHITESPACE_RUN_RE = Regex("\\s+")
    private val LEADING_INVISIBLE_RE = Regex("^[\\s\\p{Cf}\\p{Mn}]+")
    private val ONLY_PUNCTUATION_RE = Regex("^[.\u2026\\s]+$")
    private val DECLARATIONS_RE = Regex("^\\s*(?:[-\\w]+\\s*:|[.#@a-z*][^{}]*\\{)", RegexOption.IGNORE_CASE)
    private val AT_RULE_RE = Regex("^@(?:media|font-face|import|supports|keyframes|charset|page)\\b")
    private val SELECTOR_RE = Regex("^[.#]?[a-z*](?:[\\w\\-.#,>~+*\\s\\[\\]=\"']|:(?!\\s))*\\{", RegexOption.IGNORE_CASE)
    private val IMPORT_OR_CHARSET_RE = Regex("^@(?:import|charset)\\b")
    private val EMPHASIS_RE = Regex("(^|[\\s(\\[{\"'])(\\*\\*|__|\\*|_)([^\\s*_]|[^\\s*_].*?[^\\s])\\2(?=$|[\\s)\\]}\"']|[.,;:!?](?!\\w))")

    fun singleLine(text: String?): String {
        if (text.isNullOrEmpty()) return ""
        return WHITESPACE_RUN_RE.replace(text) { m ->
            if (m.value == "\u00A0") "\u00A0" else " "
        }.trim()
    }

    fun stripInvisibleLeading(text: String): String {
        val stripped = LEADING_INVISIBLE_RE.replaceFirst(text, "")
        return if (ONLY_PUNCTUATION_RE.matches(stripped)) "" else stripped
    }

    fun stripLeadingCss(text: String): String {
        var rest = text.trimStart()
        var guard = 0
        while (guard < 100 && (AT_RULE_RE.containsMatchIn(rest) || SELECTOR_RE.containsMatchIn(rest))) {
            guard++
            val brace = rest.indexOf('{')
            val semicolon = rest.indexOf(';')
            if (semicolon >= 0 && (brace < 0 || semicolon < brace) && IMPORT_OR_CHARSET_RE.containsMatchIn(rest)) {
                rest = rest.substring(semicolon + 1).trimStart()
                continue
            }
            if (brace < 0) return rest
            var depth = 0
            var end = -1
            for (i in brace until rest.length) {
                when (rest[i]) {
                    '{' -> depth++
                    '}' -> {
                        depth--
                        if (depth == 0) {
                            end = i
                            break
                        }
                    }
                }
            }
            if (end < 0) {
                return if (rest.startsWith("@") || DECLARATIONS_RE.containsMatchIn(rest.substring(brace + 1))) "" else rest
            }
            if (!rest.startsWith("@") && !DECLARATIONS_RE.containsMatchIn(rest.substring(brace + 1, end))) {
                return rest
            }
            rest = rest.substring(end + 1).trimStart()
        }
        return rest
    }

    fun stripEmphasisMarkers(text: String): String =
        EMPHASIS_RE.replace(text, "$1$3")

    fun cleanPreview(text: String?): String =
        stripEmphasisMarkers(stripInvisibleLeading(stripLeadingCss(stripInvisibleLeading(text ?: ""))))

    // ─── Avatar Initials, Color & Favicon (mirrors src/lib/avatar-utils.ts) ──

    private val LEADING_NON_ALNUM_RE = Regex("^[^\\p{L}\\p{N}]+")

    fun getEmailInitials(name: String?, email: String?): String {
        val cleanName = name?.trim().orEmpty()
        if (cleanName.isNotEmpty()) {
            val parts = cleanName
                .split(Regex("\\s+"))
                .map { LEADING_NON_ALNUM_RE.replaceFirst(it, "") }
                .filter { it.isNotEmpty() }
            if (parts.size >= 2) {
                return "${parts.first().first()}${parts.last().first()}".uppercase()
            }
            if (parts.size == 1) {
                return parts.first().take(2).uppercase()
            }
            return cleanName.take(2).uppercase()
        }
        val cleanEmail = email?.trim().orEmpty()
        if (cleanEmail.isNotEmpty()) {
            return cleanEmail.first().uppercaseChar().toString()
        }
        return "?"
    }

    fun generateEmailAvatarColorHex(name: String?, email: String?): String {
        val str = name?.takeIf { it.isNotEmpty() } ?: email?.takeIf { it.isNotEmpty() } ?: ""
        var hash = 0
        for (i in 0 until str.length) {
            hash = str[i].code + ((hash shl 5) - hash)
        }
        // Maintain identical 32-bit signed/unsigned modulus behavior with JS `Math.abs(hash) % 360`
        val hue = abs(hash.toLong()) % 360L
        return hslToHex(hue.toInt(), 70, 50)
    }

    fun hslToHex(h: Int, sPercent: Int, lPercent: Int): String {
        val s = sPercent / 100.0
        val l = lPercent / 100.0
        val a = s * min(l, 1.0 - l)
        fun component(n: Int): String {
            val k = (n + h / 30.0) % 12.0
            val c = l - a * max(-1.0, min(min(k - 3.0, 9.0 - k), 1.0))
            val byteVal = (255.0 * c).roundToInt().coerceIn(0, 255)
            return byteVal.toString(16).padStart(2, '0')
        }
        return "#${component(0)}${component(8)}${component(4)}"
    }

    private val MULTI_PART_TLDS = setOf(
        "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk",
        "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
        "co.kr", "or.kr", "go.kr", "ac.kr",
        "co.in", "net.in", "org.in", "ac.in", "gov.in",
        "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz",
        "co.za", "org.za", "net.za", "gov.za", "ac.za",
        "com.au", "net.au", "org.au", "edu.au", "gov.au",
        "com.br", "net.br", "org.br", "edu.br", "gov.br",
        "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
        "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
        "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw",
        "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk",
        "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg",
        "com.my", "net.my", "org.my", "edu.my", "gov.my",
        "com.ph", "net.ph", "org.ph", "edu.ph", "gov.ph",
        "com.pk", "net.pk", "org.pk", "edu.pk", "gov.pk",
        "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
        "co.il", "org.il", "net.il", "ac.il", "gov.il",
        "co.th", "or.th", "ac.th", "go.th", "in.th",
        "co.id", "or.id", "ac.id", "go.id", "web.id",
        "com.tr", "net.tr", "org.tr", "edu.tr", "gov.tr",
        "com.ua", "net.ua", "org.ua", "edu.ua", "gov.ua",
        "com.eg", "net.eg", "org.eg", "edu.eg", "gov.eg",
        "com.sa", "net.sa", "org.sa", "edu.sa", "gov.sa",
        "co.ke", "or.ke", "ac.ke", "go.ke", "ne.ke",
    )

    private val PERSONAL_DOMAINS = setOf(
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
        "msn.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp",
        "aol.com", "icloud.com", "me.com", "mac.com", "mail.com",
        "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.com",
        "zoho.com", "yandex.com", "yandex.ru", "gmx.com", "gmx.net",
        "fastmail.com", "hey.com", "posteo.de", "mailbox.org",
        "example.com", "example.org",
    )

    fun getRootDomain(domain: String): String {
        val parts = domain.split(".")
        if (parts.size <= 2) return domain
        val lastTwo = parts.takeLast(2).joinToString(".")
        if (MULTI_PART_TLDS.contains(lastTwo)) {
            return if (parts.size >= 3) parts.takeLast(3).joinToString(".") else domain
        }
        return lastTwo
    }

    fun getFaviconDomain(email: String?): String? {
        if (email.isNullOrBlank()) return null
        val at = email.indexOf('@')
        if (at < 0) return null
        val domain = email.substring(at + 1).trim().lowercase()
        if (domain.isEmpty()) return null
        val root = getRootDomain(domain)
        return if (PERSONAL_DOMAINS.contains(root)) null else root
    }

    fun getFaviconUrl(domain: String): String {
        val encoded = URLEncoder.encode(domain, StandardCharsets.UTF_8.name())
        return "https://icons.duckduckgo.com/ip3/$encoded.ico"
    }

    // ─── JMAP Request & Response Parsing (JVM-unit-testable) ────────────────

    fun buildJmapEmailAndMailboxGetBody(jmapAccountId: String, emailIds: List<String>): JSONObject {
        val idsJson = JSONArray()
        emailIds.take(5).forEach { idsJson.put(it) }

        val emailProps = JSONArray().apply {
            put("id")
            put("threadId")
            put("from")
            put("subject")
            put("preview")
            put("keywords")
            put("receivedAt")
        }
        val emailGetArgs = JSONObject().apply {
            put("accountId", jmapAccountId)
            put("ids", idsJson)
            put("properties", emailProps)
        }

        val mailboxProps = JSONArray().apply {
            put("id")
            put("role")
        }
        val mailboxGetArgs = JSONObject().apply {
            put("accountId", jmapAccountId)
            put("properties", mailboxProps)
        }

        val methodCalls = JSONArray().apply {
            put(JSONArray().apply {
                put("Email/get")
                put(emailGetArgs)
                put("0")
            })
            put(JSONArray().apply {
                put("Mailbox/get")
                put(mailboxGetArgs)
                put("1")
            })
        }

        return JSONObject().apply {
            put("using", JSONArray().apply {
                put("urn:ietf:params:jmap:core")
                put("urn:ietf:params:jmap:mail")
            })
            put("methodCalls", methodCalls)
        }
    }

    /**
     * Parses a JMAP response containing `Email/get` (callId "0") and `Mailbox/get` (callId "1").
     * - Returns [JmapFetchResult.Failure] if the JSON is malformed, `methodResponses` is missing,
     *   or `Email/get` returned a JMAP method error or no `list` (so the caller falls back to JS).
     * - Returns [JmapFetchResult.Success] with the filtered, oldest-first-sorted notifiable emails
     *   and `hasTrash` flag when `Email/get` succeeded (even if all emails were already `$seen` or `$junk`).
     */
    fun parseJmapGetResponse(responseBody: String, alreadyNotified: Set<String>): JmapFetchResult {
        return try {
            val root = JSONObject(responseBody)
            val methodResponses = root.optJSONArray("methodResponses")
                ?: return JmapFetchResult.Failure("Missing methodResponses")

            var emailList: JSONArray? = null
            var hasTrash = false

            for (i in 0 until methodResponses.length()) {
                val resp = methodResponses.optJSONArray(i) ?: continue
                val name = resp.optString(0)
                val body = resp.optJSONObject(1)
                val callId = resp.optString(2)

                if (callId == "0") {
                    if (name != "Email/get" || body == null) {
                        val errType = body?.optString("type", name) ?: name
                        return JmapFetchResult.Failure("Email/get failed: $errType")
                    }
                    emailList = body.optJSONArray("list")
                        ?: return JmapFetchResult.Failure("Email/get missing list")
                } else if (callId == "1" && name == "Mailbox/get" && body != null) {
                    val mbList = body.optJSONArray("list")
                    if (mbList != null) {
                        for (j in 0 until mbList.length()) {
                            val mb = mbList.optJSONObject(j) ?: continue
                            if (mb.optString("role") == "trash") {
                                hasTrash = true
                                break
                            }
                        }
                    }
                }
            }

            val list = emailList ?: return JmapFetchResult.Failure("No Email/get response for callId 0")
            val candidates = mutableListOf<PushedEmail>()

            for (j in 0 until list.length()) {
                val email = list.optJSONObject(j) ?: continue
                val id = email.optString("id")
                if (id.isBlank() || alreadyNotified.contains(id)) continue

                val keywords = email.optJSONObject("keywords")
                if (keywords?.optBoolean("\$seen", false) == true ||
                    keywords?.optBoolean("\$junk", false) == true
                ) {
                    continue
                }

                val threadId = email.optString("threadId", id).ifBlank { id }
                val rawSubject = if (email.isNull("subject")) "" else email.optString("subject", "")
                val rawPreview = if (email.isNull("preview")) "" else email.optString("preview", "")
                val receivedAtStr = if (email.isNull("receivedAt")) "" else email.optString("receivedAt", "")
                val receivedAtEpochMs = parseIsoTimestampMs(receivedAtStr)

                val fromArr = email.optJSONArray("from")
                val fromObj = fromArr?.optJSONObject(0)
                val senderName = if (fromObj == null || fromObj.isNull("name")) "" else fromObj.optString("name", "").trim()
                val senderEmail = if (fromObj == null || fromObj.isNull("email")) "" else fromObj.optString("email", "").trim()

                candidates.add(
                    PushedEmail(
                        id = id,
                        threadId = threadId,
                        senderName = senderName,
                        senderEmail = senderEmail,
                        subject = singleLine(rawSubject),
                        preview = singleLine(cleanPreview(rawPreview)),
                        receivedAtEpochMs = receivedAtEpochMs,
                    )
                )
            }

            // Oldest first so the newest ends up on top of the notification tray
            // (matching push-background-task.ts lines 633-635).
            val ordered = candidates.sortedBy { it.receivedAtEpochMs }
            JmapFetchResult.Success(emails = ordered, hasTrash = hasTrash)
        } catch (e: Exception) {
            JmapFetchResult.Failure("Invalid JMAP JSON: ${e.message}")
        }
    }

    private fun parseIsoTimestampMs(iso: String): Long {
        if (iso.isBlank()) return 0L
        return try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            0L
        }
    }

    fun parseStoredCredentialsJson(rawJsonStr: String): StoredCredentials? {
        return try {
            val obj = JSONObject(rawJsonStr)
            val serverUrl = obj.optString("serverUrl").takeIf { it.isNotBlank() } ?: return null
            val username = obj.optString("username").takeIf { it.isNotBlank() } ?: return null
            val password = if (obj.isNull("password")) null else obj.optString("password").takeIf { it.isNotEmpty() }
            val accessToken = if (obj.isNull("accessToken")) null else obj.optString("accessToken").takeIf { it.isNotBlank() }
            val refreshToken = if (obj.isNull("refreshToken")) null else obj.optString("refreshToken").takeIf { it.isNotBlank() }
            val expiresAt = obj.optLong("expiresAt", 0L)
            val tokenEndpoint = if (obj.isNull("tokenEndpoint")) null else obj.optString("tokenEndpoint").takeIf { it.isNotBlank() }
            val clientId = if (obj.isNull("clientId")) null else obj.optString("clientId").takeIf { it.isNotBlank() }
            StoredCredentials(
                rawJson = obj,
                serverUrl = serverUrl,
                username = username,
                password = password,
                accessToken = accessToken,
                refreshToken = refreshToken,
                expiresAt = expiresAt,
                tokenEndpoint = tokenEndpoint,
                clientId = clientId,
            )
        } catch (_: Exception) {
            null
        }
    }

    // ─── Shared Expo SecureStore Access (AndroidKeyStore AES/GCM/NoPadding) ──

    private data class SecureStoreEntryMetadata(
        val prefKey: String,
        val keystoreAlias: String,
        val usesKeystoreSuffix: Boolean,
        val secretKeyEntry: KeyStore.SecretKeyEntry,
        val plaintext: String,
    )

    private fun readExpoSecureStoreEntry(context: Context, key: String): SecureStoreEntryMetadata? {
        val prefs = context.getSharedPreferences(SECURE_STORE_PREFS_NAME, Context.MODE_PRIVATE)
        val keychainAwareKey = "$DEFAULT_KEYSTORE_ALIAS-$key"
        val (prefKey, encryptedItemString) = when {
            prefs.contains(keychainAwareKey) -> keychainAwareKey to prefs.getString(keychainAwareKey, null)
            prefs.contains(key) -> key to prefs.getString(key, null)
            else -> return null
        }
        if (encryptedItemString.isNullOrBlank()) return null

        val encryptedItem = JSONObject(encryptedItemString)
        val scheme = encryptedItem.optString("scheme")
        if (scheme != "aes") return null
        if (encryptedItem.optBoolean("requireAuthentication", false)) return null

        val usesKeystoreSuffix = encryptedItem.optBoolean("usesKeystoreSuffix", false)
        val keystoreAliasProp = encryptedItem.optString("keystoreAlias", DEFAULT_KEYSTORE_ALIAS)
            .ifBlank { DEFAULT_KEYSTORE_ALIAS }

        val fullKeystoreAlias = if (usesKeystoreSuffix) {
            "$AES_CIPHER:$keystoreAliasProp:$UNAUTHENTICATED_KEYSTORE_SUFFIX"
        } else {
            "$AES_CIPHER:$keystoreAliasProp"
        }

        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE_PROVIDER).apply { load(null) }
        if (!keyStore.containsAlias(fullKeystoreAlias)) return null
        val secretKeyEntry = keyStore.getEntry(fullKeystoreAlias, null) as? KeyStore.SecretKeyEntry
            ?: return null

        val ctBase64 = encryptedItem.optString("ct").takeIf { it.isNotBlank() } ?: return null
        val ivBase64 = encryptedItem.optString("iv").takeIf { it.isNotBlank() } ?: return null
        val tlen = encryptedItem.optInt("tlen", 128)
        if (tlen < MIN_GCM_TAG_LENGTH_BITS) return null

        val ciphertextBytes = Base64.getMimeDecoder().decode(ctBase64)
        val ivBytes = Base64.getMimeDecoder().decode(ivBase64)
        val cipher = Cipher.getInstance(AES_CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, secretKeyEntry.secretKey, GCMParameterSpec(tlen, ivBytes))
        val plaintext = String(cipher.doFinal(ciphertextBytes), StandardCharsets.UTF_8)

        return SecureStoreEntryMetadata(
            prefKey = prefKey,
            keystoreAlias = keystoreAliasProp,
            usesKeystoreSuffix = usesKeystoreSuffix,
            secretKeyEntry = secretKeyEntry,
            plaintext = plaintext,
        )
    }

    fun readCredentialsFromSecureStore(context: Context, credentialsKey: String): StoredCredentials? {
        synchronized(secureStoreLock) {
            return try {
                val entry = readExpoSecureStoreEntry(context, credentialsKey) ?: return null
                parseStoredCredentialsJson(entry.plaintext)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read credentials from SecureStore for $credentialsKey: ${e.message}")
                null
            }
        }
    }

    /**
     * Updates OAuth tokens in-place inside Expo SecureStore's entry so both native and JS
     * share a single copy of the tokens. Re-reads the entry under `secureStoreLock` first
     * (mirroring `SharedKeychain.updateAccountTokens` on iOS) to ensure a sign-out or
     * account switch that happened while the refresh was in flight is never overwritten.
     */
    private fun updateTokensInSecureStore(
        context: Context,
        credentialsKey: String,
        expectedUsername: String,
        expectedServerUrl: String,
        fresh: FreshTokens,
        nowMs: Long,
    ): StoredCredentials? {
        synchronized(secureStoreLock) {
            return try {
                val currentEntry = readExpoSecureStoreEntry(context, credentialsKey) ?: return null
                val currentCreds = parseStoredCredentialsJson(currentEntry.plaintext) ?: return null
                if (currentCreds.username != expectedUsername || currentCreds.serverUrl != expectedServerUrl) {
                    return null
                }

                val expiresAt = nowMs + (fresh.expiresIn * 1000.0).toLong()
                val updatedJson = currentCreds.rawJson.apply {
                    put("accessToken", fresh.accessToken)
                    if (!fresh.refreshToken.isNullOrBlank()) {
                        put("refreshToken", fresh.refreshToken)
                    }
                    put("expiresAt", expiresAt)
                }
                val updatedPlaintext = updatedJson.toString()

                val cipher = Cipher.getInstance(AES_CIPHER)
                cipher.init(Cipher.ENCRYPT_MODE, currentEntry.secretKeyEntry.secretKey)
                val gcmSpec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
                val ciphertextBytes = cipher.doFinal(updatedPlaintext.toByteArray(StandardCharsets.UTF_8))

                val encryptedItem = JSONObject().apply {
                    put("ct", Base64.getEncoder().encodeToString(ciphertextBytes))
                    put("iv", Base64.getEncoder().encodeToString(gcmSpec.iv))
                    put("tlen", gcmSpec.tLen)
                    put("scheme", "aes")
                    put("usesKeystoreSuffix", currentEntry.usesKeystoreSuffix)
                    put("keystoreAlias", currentEntry.keystoreAlias)
                    put("requireAuthentication", false)
                }

                val prefs = context.getSharedPreferences(SECURE_STORE_PREFS_NAME, Context.MODE_PRIVATE)
                prefs.edit().putString(currentEntry.prefKey, encryptedItem.toString()).commit()

                parseStoredCredentialsJson(updatedPlaintext)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to update refreshed tokens in SecureStore for $credentialsKey: ${e.message}")
                null
            }
        }
    }

    /**
     * pushSubscriptionNeedsExtension in src/lib/push-notifications.ts: the
     * recorded expiry is less than six days away, has passed or is unknown.
     */
    fun subscriptionNeedsExtension(expires: String?, nowMs: Long): Boolean {
        val at = parseIsoTimestampMs(expires.orEmpty())
        return at == 0L || at - nowMs < EXTEND_SUBSCRIPTION_BELOW_MS
    }

    /**
     * Whether the JS push task should still run for a push handled here:
     * it extends the account's push subscription (extendPushSubscription in
     * src/lib/push-background-task.ts), which servers drop about a week after
     * its last extension. The task finds the mail already notified and shows
     * nothing. pushSubscriptionDueForExtension in push-notifications.ts.
     */
    fun pushSubscriptionDueForExtension(context: Context, data: Map<String, String>): Boolean {
        return try {
            val jmapAccountId = data["accountId"]?.takeIf { it.isNotBlank() } ?: return false
            val accountRaw = getPrefs(context).getString(jmapAccountId, null) ?: return false
            val localAccountId = JSONObject(accountRaw).optString("accountId").takeIf { it.isNotBlank() }
                ?: return false
            if (!readAsyncStorageItem(context, optedOutKeyFor(localAccountId)).isNullOrBlank()) return false
            if (readAsyncStorageItem(context, SUBSCRIPTION_ID_PREFIX + localAccountId).isNullOrBlank()) return false
            subscriptionNeedsExtension(
                readAsyncStorageItem(context, SUBSCRIPTION_EXPIRES_PREFIX + localAccountId),
                System.currentTimeMillis(),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Could not tell whether the push subscription is due: ${e.message}")
            false
        }
    }

    // ─── Shared AsyncStorage (`RKStorage`) Access ───────────────────────────

    private fun readAsyncStorageItem(context: Context, key: String): String? {
        return try {
            val supplier = ReactDatabaseSupplier.getInstance(context)
            synchronized(supplier) {
                val db = supplier.get()
                AsyncLocalStorageUtil.getItemImpl(db, key)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read AsyncStorage key $key: ${e.message}")
            null
        }
    }

    private fun writeAsyncStorageItems(context: Context, pairs: List<Pair<String, String>>) {
        if (pairs.isEmpty()) return
        try {
            val supplier = ReactDatabaseSupplier.getInstance(context)
            synchronized(supplier) {
                val db = supplier.get()
                db.beginTransaction()
                try {
                    for ((key, value) in pairs) {
                        val cv = ContentValues().apply {
                            put("key", key)
                            put("value", value)
                        }
                        db.insertWithOnConflict(
                            "catalystLocalStorage",
                            null,
                            cv,
                            SQLiteDatabase.CONFLICT_REPLACE,
                        )
                    }
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write AsyncStorage keys: ${e.message}")
        }
    }

    private fun readNotifiedIds(context: Context, localAccountId: String): List<String> {
        val rawRing = readAsyncStorageItem(context, notifiedIdsKeyFor(localAccountId))
        val legacySingle = if (rawRing.isNullOrBlank()) {
            readAsyncStorageItem(context, lastNotifiedKeyFor(localAccountId))
        } else {
            null
        }
        return parseNotifiedIds(rawRing, legacySingle)
    }

    private fun removeAsyncStorageItems(context: Context, keys: List<String>) {
        try {
            val supplier = ReactDatabaseSupplier.getInstance(context)
            synchronized(supplier) {
                val db = supplier.get()
                db.beginTransaction()
                try {
                    for (key in keys) db.delete("catalystLocalStorage", "key = ?", arrayOf(key))
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove AsyncStorage keys: ${e.message}")
        }
    }

    private fun notifiedIdsStore(context: Context) = object : NotifiedIdsStore {
        override fun read(accountId: String) = readNotifiedIds(context, accountId)

        override fun write(accountId: String, ring: List<String>) {
            if (ring.isEmpty()) return
            val json = JSONArray().apply { ring.forEach { put(it) } }.toString()
            writeAsyncStorageItems(
                context,
                listOf(
                    notifiedIdsKeyFor(accountId) to json,
                    lastNotifiedKeyFor(accountId) to ring.first(),
                ),
            )
        }

        override fun remove(accountId: String) =
            removeAsyncStorageItems(context, listOf(notifiedIdsKeyFor(accountId), lastNotifiedKeyFor(accountId)))
    }

    private val notifiedOnce = NotifiedOnce()

    /**
     * Posts through [post] unless every one of [ids] was notified for the
     * account before, and records them once posted (see [NotifiedOnce]).
     * Every message notification goes through here, from either runtime.
     */
    fun postOnce(context: Context, localAccountId: String, ids: List<String>, post: () -> Unit): Boolean =
        notifiedOnce.post(notifiedIdsStore(context), localAccountId, ids, post)

    /** Forgets the account's notified ids, under the same lock as [postOnce]. */
    fun forgetNotifiedIds(context: Context, localAccountId: String) =
        notifiedOnce.forget(notifiedIdsStore(context), localAccountId)

    // ─── Auth Header, Token Refresh & Authenticated JMAP Request ────────────

    /**
     * Executes a JMAP POST request with stored credentials:
     * - Refreshes the OAuth access token beforehand if it is within 60s of expiry.
     * - If the server responds with HTTP 401 (e.g. clock skew or early server-side token
     *   revocation) and the token was not just refreshed, refreshes the OAuth token in-place
     *   in Expo SecureStore and retries the request once (matching `plugins/ios-push/Jmap.swift`).
     */
    private fun executeAuthenticatedJmapPost(
        context: Context,
        apiUrl: String,
        credentialsKey: String,
        creds: StoredCredentials,
        bodyJson: JSONObject,
        deadlineMs: Long = System.currentTimeMillis() + ACTION_BUDGET_MS,
    ): String? {
        var activeCreds = creds
        var refreshedAlready = false
        val accessToken = activeCreds.accessToken

        val initialAuthHeader = if (!accessToken.isNullOrBlank()) {
            val now = System.currentTimeMillis()
            if (activeCreds.expiresAt > 0L && activeCreds.expiresAt - now <= TOKEN_REFRESH_LEEWAY_MS) {
                activeCreds = renewedCredentials(context, credentialsKey, activeCreds, deadlineMs) ?: return null
                refreshedAlready = true
            }
            "Bearer ${activeCreds.accessToken}"
        } else {
            val password = activeCreds.password
            if (activeCreds.username.isNotBlank() && !password.isNullOrEmpty()) {
                val basic = Base64.getEncoder().encodeToString(
                    "${activeCreds.username}:$password".toByteArray(StandardCharsets.UTF_8)
                )
                "Basic $basic"
            } else {
                return null
            }
        }

        val requestBodyStr = bodyJson.toString()
        fun postWithAuth(authHeader: String): Pair<Int, String?> {
            val request = Request.Builder()
                .url(apiUrl)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .addHeader("Authorization", authHeader)
                .post(requestBodyStr.toRequestBody(JSON_MEDIA_TYPE))
                .build()
            return executeBefore(httpClient, request, deadlineMs) { response ->
                response.code to if (response.isSuccessful) response.body?.string() else null
            }
        }

        val (statusCode, firstBody) = postWithAuth(initialAuthHeader)
        if (firstBody != null) return firstBody

        if (statusCode == 401 && !refreshedAlready && !activeCreds.accessToken.isNullOrBlank()) {
            val renewed = renewedCredentials(context, credentialsKey, activeCreds, deadlineMs) ?: return null
            val (retryCode, retryBody) = postWithAuth("Bearer ${renewed.accessToken}")
            if (retryBody == null) {
                Log.w(TAG, "JMAP retry after 401 token refresh failed with status $retryCode")
            }
            return retryBody
        }

        Log.w(TAG, "JMAP HTTP request failed with status $statusCode")
        return null
    }

    /**
     * Whether [stored] holds a newer access token than [stale] that is not
     * about to expire: the app (or another push) refreshed it meanwhile. The
     * rule of adoptStoredTokens in src/api/jmap-client.ts.
     */
    fun storedTokensReplace(stale: StoredCredentials, stored: StoredCredentials, nowMs: Long): Boolean =
        !stored.accessToken.isNullOrBlank() &&
            stored.accessToken != stale.accessToken &&
            stored.expiresAt > stale.expiresAt &&
            stored.expiresAt - nowMs > TOKEN_REFRESH_LEEWAY_MS

    /**
     * Credentials with a usable access token in place of [stale]'s, or null.
     * Storage is read again first, under [refreshLock]: the app or another
     * push may have refreshed already, and on a server that rotates refresh
     * tokens the one in [stale] is then spent. Refreshing with it would fail
     * at best and, with reuse detection, revoke the sign-in. Only when storage
     * has nothing newer is the token endpoint asked, with the stored refresh
     * token, and the new tokens are written back for the app.
     */
    private fun renewedCredentials(
        context: Context,
        credentialsKey: String,
        stale: StoredCredentials,
        deadlineMs: Long,
    ): StoredCredentials? {
        synchronized(refreshLock) {
            // Signed out meanwhile: nothing to refresh.
            val stored = readCredentialsFromSecureStore(context, credentialsKey) ?: return null
            val now = System.currentTimeMillis()
            if (storedTokensReplace(stale, stored, now)) return stored
            val refreshToken = stored.refreshToken ?: return null
            val tokenEndpoint = stored.tokenEndpoint ?: return null
            val fresh = refreshOAuthToken(tokenEndpoint, refreshToken, stored.clientId, deadlineMs) ?: return null
            return updateTokensInSecureStore(
                context = context,
                credentialsKey = credentialsKey,
                expectedUsername = stale.username,
                expectedServerUrl = stale.serverUrl,
                fresh = fresh,
                nowMs = now,
            ) ?: run {
                Log.w(TAG, "Refreshed tokens for $credentialsKey could not be stored")
                stored.copy(accessToken = fresh.accessToken, refreshToken = fresh.refreshToken ?: refreshToken)
            }
        }
    }

    private fun refreshOAuthToken(
        tokenEndpoint: String,
        refreshToken: String,
        clientId: String?,
        deadlineMs: Long,
    ): FreshTokens? {
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

            executeBefore(tokenClient, req, deadlineMs) { resp ->
                if (!resp.isSuccessful) return null
                val bodyStr = resp.body?.string() ?: return null
                val body = JSONObject(bodyStr)
                val accessToken = body.optString("access_token").takeIf { it.isNotBlank() } ?: return null
                val newRefresh = if (body.isNull("refresh_token")) null else body.optString("refresh_token").takeIf { it.isNotBlank() }
                val expiresIn = body.optDouble("expires_in", 3600.0)
                FreshTokens(accessToken, newRefresh, expiresIn)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun readLocalizedStrings(context: Context, accountObj: JSONObject): LocalizedStrings {
        val stringsObj = accountObj.optJSONObject("strings")
        return LocalizedStrings(
            newEmail = stringsObj?.optString("newEmail")?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notification_new_email),
            noSubject = stringsObj?.optString("noSubject")?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notification_no_subject),
            markRead = stringsObj?.optString("markRead")?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notification_action_mark_read),
            delete = stringsObj?.optString("delete")?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notification_action_delete),
            reply = stringsObj?.optString("reply")?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notification_action_reply),
        )
    }

    // ─── Main Push Entry Point ──────────────────────────────────────────────

    /**
     * java.util.Base64 and java.time need Android 8 (API 26) and the app
     * starts at 24 without library desugaring: on Android 7 they throw
     * NoClassDefFoundError, an Error the catch blocks here don't take. The
     * JS task handles pushes and actions there, as before.
     */
    private fun supportedOnThisDevice(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    /**
     * Attempts to fetch new mail metadata and post notifications natively.
     *
     * Return value semantics:
     * - `true`: The push has been completely handled (notifications posted, or notifications
     *   are disabled for this account, or all pushed message IDs were already notified / already
     *   read / marked as junk on the server). The caller MUST NOT start the headless JS task.
     * - `false`: Native could not handle the push (no shared account metadata, legacy push
     *   without `emailIds`, label mismatch / multi-account ambiguity, missing credentials, or
     *   network / JMAP error). The caller falls back to the headless JS task.
     */
    fun processPush(context: Context, data: Map<String, String>): Boolean {
        if (!supportedOnThisDevice()) return false
        val deadlineMs = System.currentTimeMillis() + PUSH_BUDGET_MS
        return try {
            val jmapAccountId = data["accountId"]?.takeIf { it.isNotBlank() } ?: return false
            val prefs = getPrefs(context)
            val accountRaw = prefs.getString(jmapAccountId, null) ?: return false

            val account = JSONObject(accountRaw)
            val apiUrl = account.optString("apiUrl").takeIf { it.isNotBlank() } ?: return false
            val localAccountId = account.optString("accountId").takeIf { it.isNotBlank() } ?: return false
            val label = if (account.isNull("label")) null else account.optString("label").takeIf { it.isNotBlank() }
            val credentialsKey = account.optString("credentialsKey")
                .takeIf { it.isNotBlank() }
                ?: credentialsKeyFor(localAccountId)

            // Validate push label if present (mirroring NotificationService.swift)
            val pushLabel = data["accountLabel"]
            if (!pushLabelMatchesAccount(pushLabel, label, localAccountId)) {
                Log.w(TAG, "Push label does not fit shared account for $jmapAccountId ($pushLabel vs $label)")
                return false
            }

            // Respect user notification settings and per-account opt-out directly from AsyncStorage
            val optedOut = readAsyncStorageItem(context, optedOutKeyFor(localAccountId))
            if (!optedOut.isNullOrBlank()) {
                Log.i(TAG, "Push received for opted-out account $localAccountId; skipping")
                return true
            }
            val settingsJson = readAsyncStorageItem(context, SETTINGS_STORAGE_KEY)
            if (!isEmailNotificationsEnabledInSettings(settingsJson)) {
                Log.i(TAG, "Push received while email notifications are disabled; skipping")
                return true
            }

            // Extract email IDs; legacy state-change payloads without IDs fall back to JS
            val rawEmailIds = extractEmailIds(data)
            if (rawEmailIds.isEmpty()) {
                Log.i(TAG, "Push carries no emailIds; falling back to headless JS task")
                return false
            }

            // Skips the lookup for ids notified before (`push:notifiedIds:v1:<accountId>`);
            // the guard against posting one twice is in postNotificationNatively.
            val alreadyNotified = readNotifiedIds(context, localAccountId).toSet()
            val freshEmailIds = rawEmailIds.filter { !alreadyNotified.contains(it) }
            if (freshEmailIds.isEmpty()) {
                Log.i(TAG, "All email IDs already notified for account $localAccountId; skipping")
                return true
            }

            // Read credentials from Expo SecureStore (and refresh OAuth token in-place if needed)
            val creds = readCredentialsFromSecureStore(context, credentialsKey) ?: return false

            // Execute single-round-trip JMAP Email/get + Mailbox/get request (with 401 refresh retry)
            val bodyJson = buildJmapEmailAndMailboxGetBody(jmapAccountId, freshEmailIds)
            val responseBody = executeAuthenticatedJmapPost(
                context = context,
                apiUrl = apiUrl,
                credentialsKey = credentialsKey,
                creds = creds,
                bodyJson = bodyJson,
                deadlineMs = deadlineMs,
            ) ?: return false

            when (val result = parseJmapGetResponse(responseBody, alreadyNotified)) {
                is JmapFetchResult.Failure -> {
                    Log.w(TAG, "JMAP response failure (${result.reason}); falling back to headless JS task")
                    return false
                }
                is JmapFetchResult.Success -> {
                    val emails = result.emails
                    if (emails.isEmpty()) {
                        // Nothing new to show (e.g. already read on another device or marked as $junk).
                        // Return true so we don't start the headless JS task unnecessarily (#94).
                        Log.i(TAG, "Native push: all fetched messages are already read or junk; nothing to show")
                        return true
                    }

                    val strings = readLocalizedStrings(context, account)
                    val faviconsEnabled = isSenderFaviconsEnabledInSettings(settingsJson)
                    val groupKey = "bulwark-mail:$localAccountId"
                    val groupTitle = label ?: localAccountId.substringBefore('@').ifBlank { localAccountId }

                    var posted = 0
                    for (email in emails) {
                        val title = email.senderName.ifBlank {
                            email.senderEmail.ifBlank { strings.newEmail }
                        }
                        val displaySubject = email.subject.ifBlank { strings.noSubject }
                        val initials = getEmailInitials(email.senderName, email.senderEmail)
                        val bgColorHex = generateEmailAvatarColorHex(email.senderName, email.senderEmail)
                        // An icon fetch can take seconds: only while the budget allows it.
                        val iconUrl = if (faviconsEnabled && deadlineMs - System.currentTimeMillis() >= FAVICON_MIN_LEFT_MS) {
                            getFaviconDomain(email.senderEmail)?.let { getFaviconUrl(it) }
                        } else {
                            null
                        }

                        val shown = BulwarkFcmModule.postNotificationNatively(
                            context = context,
                            notificationId = "mail:${email.id}",
                            title = title,
                            body = displaySubject,
                            preview = email.preview.ifBlank { null },
                            initials = initials,
                            bgColorHex = bgColorHex,
                            iconUrl = iconUrl,
                            emailId = email.id,
                            threadId = email.threadId,
                            subject = email.subject.ifBlank { null },
                            accountId = localAccountId,
                            jmapAccountId = jmapAccountId,
                            groupKey = groupKey,
                            groupTitle = groupTitle,
                            markReadLabel = strings.markRead,
                            deleteLabel = strings.delete,
                            replyLabel = strings.reply,
                            deleteNeedsUnlock = !result.hasTrash,
                        )
                        if (shown) posted++
                    }

                    // Each notification posted recorded its id in the shared ring
                    // (postNotificationNatively); one already posted by another push was skipped.
                    Log.i(TAG, "Native push: successfully posted $posted notification(s)")
                    return true
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "processPush exception: ${e.message}", e)
            false
        }
    }

    // ─── Native Notification Action Execution (Mark as Read / Delete) ───────

    /**
     * Executes a notification action (`markRead` or `delete`) natively over JMAP
     * so action buttons work reliably even when the app is cached/dozing on Samsung One UI.
     * Returns `true` if the action succeeded natively, or `false` to fall back to Headless JS.
     */
    fun executeNotificationAction(
        context: Context,
        action: String,
        emailId: String,
        accountId: String,
        jmapAccountId: String?,
    ): Boolean {
        if (!supportedOnThisDevice()) return false
        val deadlineMs = System.currentTimeMillis() + ACTION_BUDGET_MS
        return try {
            val prefs = getPrefs(context)
            var accountObj: JSONObject? = null
            var resolvedJmapAccountId: String? = jmapAccountId?.takeIf { it.isNotBlank() }

            if (resolvedJmapAccountId != null) {
                val raw = prefs.getString(resolvedJmapAccountId, null)
                if (raw != null) accountObj = JSONObject(raw)
            }
            if (accountObj == null) {
                for ((key, value) in prefs.all) {
                    val raw = value as? String ?: continue
                    val obj = try { JSONObject(raw) } catch (_: Exception) { continue }
                    if (obj.optString("accountId") == accountId) {
                        accountObj = obj
                        if (resolvedJmapAccountId == null) resolvedJmapAccountId = key
                        break
                    }
                }
            }

            val account = accountObj ?: return false
            val targetJmapAccountId = resolvedJmapAccountId ?: return false
            val apiUrl = account.optString("apiUrl").takeIf { it.isNotBlank() } ?: return false
            val credentialsKey = account.optString("credentialsKey")
                .takeIf { it.isNotBlank() }
                ?: credentialsKeyFor(accountId)

            val creds = readCredentialsFromSecureStore(context, credentialsKey) ?: return false

            when (action) {
                "markRead" -> {
                    val patch = JSONObject().apply { put("keywords/\$seen", true) }
                    executeEmailSetUpdate(context, apiUrl, credentialsKey, creds, targetJmapAccountId, emailId, patch, deadlineMs)
                }
                "delete" -> {
                    val trashId = fetchTrashMailboxId(context, apiUrl, credentialsKey, creds, targetJmapAccountId, deadlineMs)
                        ?: return false
                    // Re-read credentials in case fetchTrashMailboxId refreshed the OAuth token
                    val latestCreds = readCredentialsFromSecureStore(context, credentialsKey) ?: creds
                    val settingsJson = readAsyncStorageItem(context, SETTINGS_STORAGE_KEY)
                    val markReadToo = isDeleteMarksReadInSettings(settingsJson)
                    val patch = JSONObject().apply {
                        put("mailboxIds", JSONObject().apply { put(trashId, true) })
                        if (markReadToo) put("keywords/\$seen", true)
                    }
                    executeEmailSetUpdate(context, apiUrl, credentialsKey, latestCreds, targetJmapAccountId, emailId, patch, deadlineMs)
                }
                else -> false
            }
        } catch (e: Exception) {
            Log.w(TAG, "executeNotificationAction failed ($action, $emailId): ${e.message}")
            false
        }
    }

    private fun fetchTrashMailboxId(
        context: Context,
        apiUrl: String,
        credentialsKey: String,
        creds: StoredCredentials,
        jmapAccountId: String,
        deadlineMs: Long,
    ): String? {
        val bodyJson = JSONObject().apply {
            put("using", JSONArray().apply {
                put("urn:ietf:params:jmap:core")
                put("urn:ietf:params:jmap:mail")
            })
            put("methodCalls", JSONArray().apply {
                put(JSONArray().apply {
                    put("Mailbox/get")
                    put(JSONObject().apply {
                        put("accountId", jmapAccountId)
                        put("properties", JSONArray().apply {
                            put("id")
                            put("role")
                        })
                    })
                    put("0")
                })
            })
        }
        val responseBody = executeAuthenticatedJmapPost(
            context = context,
            apiUrl = apiUrl,
            credentialsKey = credentialsKey,
            creds = creds,
            bodyJson = bodyJson,
            deadlineMs = deadlineMs,
        ) ?: return null

        val root = JSONObject(responseBody)
        val first = root.optJSONArray("methodResponses")?.optJSONArray(0) ?: return null
        if (first.optString(0) != "Mailbox/get") return null
        val list = first.optJSONObject(1)?.optJSONArray("list") ?: return null
        for (i in 0 until list.length()) {
            val mb = list.optJSONObject(i) ?: continue
            if (mb.optString("role") == "trash") {
                return mb.optString("id").takeIf { it.isNotBlank() }
            }
        }
        return null
    }

    private fun executeEmailSetUpdate(
        context: Context,
        apiUrl: String,
        credentialsKey: String,
        creds: StoredCredentials,
        jmapAccountId: String,
        emailId: String,
        patch: JSONObject,
        deadlineMs: Long,
    ): Boolean {
        val bodyJson = JSONObject().apply {
            put("using", JSONArray().apply {
                put("urn:ietf:params:jmap:core")
                put("urn:ietf:params:jmap:mail")
            })
            put("methodCalls", JSONArray().apply {
                put(JSONArray().apply {
                    put("Email/set")
                    put(JSONObject().apply {
                        put("accountId", jmapAccountId)
                        put("update", JSONObject().apply { put(emailId, patch) })
                    })
                    put("0")
                })
            })
        }
        val responseBody = executeAuthenticatedJmapPost(
            context = context,
            apiUrl = apiUrl,
            credentialsKey = credentialsKey,
            creds = creds,
            bodyJson = bodyJson,
            deadlineMs = deadlineMs,
        ) ?: return false

        val root = JSONObject(responseBody)
        val first = root.optJSONArray("methodResponses")?.optJSONArray(0) ?: return false
        if (first.optString(0) != "Email/set") return false
        val updated = first.optJSONObject(1)?.optJSONObject("updated") ?: return false
        return updated.has(emailId)
    }
}
