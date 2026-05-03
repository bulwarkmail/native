package com.anonymous.bulwarkmobile

import android.content.Context
import android.content.SharedPreferences
import android.security.KeyChain
import android.security.KeyChainAliasCallback
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Bridges Android's KeyChain client-certificate machinery into JS so the
 * mobile app can authenticate to a reverse proxy that asks for mTLS.
 *
 * Two surfaces:
 *   1. `pickAlias` / `getAlias` / `clearAlias` — UI flow that lets the user
 *      pick a cert installed in Android's system credential store. The
 *      selected alias is persisted in SharedPreferences so the choice
 *      survives app restarts.
 *   2. `fetchSecure` — a fetch shim built on OkHttp that injects the picked
 *      cert into the TLS handshake. JS-side `fetch` cannot present client
 *      certs because RN's bundled OkHttpClient doesn't expose its KeyManager
 *      hook to userland; this method is the workaround.
 */
class BulwarkClientCertModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Volatile private var cachedAlias: String? = prefs.getString(PREF_ALIAS, null)
    @Volatile private var cachedClient: OkHttpClient? = null
    @Volatile private var cachedClientForAlias: String? = null

    override fun getName(): String = MODULE_NAME

    // ── alias management ────────────────────────────────────────

    @ReactMethod
    fun getAlias(promise: Promise) {
        promise.resolve(cachedAlias)
    }

    @ReactMethod
    fun clearAlias(promise: Promise) {
        prefs.edit().remove(PREF_ALIAS).apply()
        cachedAlias = null
        invalidateClient()
        promise.resolve(null)
    }

    /**
     * Show the system "Choose a certificate" picker. Resolves with the
     * selected alias, or `null` when the user dismisses the picker.
     *
     * @param host  optional host hint shown by the picker
     */
    @ReactMethod
    fun pickAlias(host: String?, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("no_activity", "No current activity to host the cert picker")
            return
        }
        val callback = KeyChainAliasCallback { alias ->
            // Callback runs off the main thread. We persist + resolve directly.
            if (alias.isNullOrBlank()) {
                promise.resolve(null)
                return@KeyChainAliasCallback
            }
            prefs.edit().putString(PREF_ALIAS, alias).apply()
            cachedAlias = alias
            invalidateClient()
            promise.resolve(alias)
        }
        try {
            KeyChain.choosePrivateKeyAlias(
                activity,
                callback,
                /* keyTypes */ arrayOf("RSA", "EC"),
                /* issuers */ null,
                /* host */ host,
                /* port */ -1,
                /* alias */ cachedAlias,
            )
        } catch (e: Exception) {
            promise.reject("pick_failed", e.message, e)
        }
    }

    // ── secure fetch ────────────────────────────────────────────

    /**
     * Perform an HTTP request that presents the persisted client cert (if
     * any) during the TLS handshake.
     *
     * @param request {url, method, headers: {k:v}, bodyBase64: string|null, timeoutMs: number}
     *
     * Resolves with `{status, statusText, headers, bodyBase64}` so JS can
     * reconstruct a standard `Response`-like object.
     */
    @ReactMethod
    fun fetchSecure(request: ReadableMap, promise: Promise) {
        val url = request.getString("url")
        if (url.isNullOrBlank()) {
            promise.reject("bad_args", "url is required")
            return
        }
        val method = request.getString("method") ?: "GET"
        val timeoutMs = if (request.hasKey("timeoutMs")) request.getInt("timeoutMs").toLong() else 30_000L
        val headersMap = request.getMap("headers")
        val bodyBase64 = request.getString("bodyBase64")
        val contentType = headersMap
            ?.let { h ->
                val it = h.keySetIterator()
                var ct: String? = null
                while (it.hasNextKey()) {
                    val k = it.nextKey()
                    if (k.equals("Content-Type", ignoreCase = true)) {
                        ct = h.getString(k)
                        break
                    }
                }
                ct
            }

        // Run on a worker thread so we don't block the JS thread on socket IO.
        thread(name = "BulwarkClientCert.fetch") {
            try {
                val client = buildOrReuseClient(timeoutMs)
                val builder = Request.Builder().url(url)
                headersMap?.let { h ->
                    val it = h.keySetIterator()
                    while (it.hasNextKey()) {
                        val k = it.nextKey()
                        val v = h.getString(k)
                        if (v != null) builder.addHeader(k, v)
                    }
                }
                val bodyBytes = bodyBase64?.let { Base64.decode(it, Base64.NO_WRAP) }
                val body = when {
                    bodyBytes != null -> bodyBytes.toRequestBody(contentType?.toMediaTypeOrNull())
                    methodRequiresBody(method) -> ByteArray(0).toRequestBody(contentType?.toMediaTypeOrNull())
                    else -> null
                }
                builder.method(method.uppercase(), body)
                client.newCall(builder.build()).execute().use { response ->
                    val out = Arguments.createMap()
                    out.putInt("status", response.code)
                    out.putString("statusText", response.message)
                    val headers = Arguments.createMap()
                    response.headers.forEach { (name, value) ->
                        // OkHttp can return multiple values per header; we
                        // join with ", " which is the standard wire format
                        // for repeated header values.
                        if (headers.hasKey(name)) {
                            val existing = headers.getString(name)
                            headers.putString(name, "$existing, $value")
                        } else {
                            headers.putString(name, value)
                        }
                    }
                    out.putMap("headers", headers)
                    val responseBytes = response.body?.bytes() ?: ByteArray(0)
                    out.putString("bodyBase64", Base64.encodeToString(responseBytes, Base64.NO_WRAP))
                    promise.resolve(out)
                }
            } catch (e: Exception) {
                promise.reject("fetch_failed", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    // ── internals ───────────────────────────────────────────────

    private fun invalidateClient() {
        cachedClient = null
        cachedClientForAlias = null
    }

    private fun buildOrReuseClient(timeoutMs: Long): OkHttpClient {
        val alias = cachedAlias
        val existing = cachedClient
        if (existing != null && cachedClientForAlias == alias) return existing

        val builder = OkHttpClient.Builder()
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)

        if (alias != null) {
            val ctx = reactApplicationContext
            val km = KeyChainKeyManager(ctx, alias)
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(null as java.security.KeyStore?)
            val trustManagers = tmf.trustManagers
            val tm = trustManagers.firstOrNull { it is X509TrustManager } as X509TrustManager?
                ?: throw IllegalStateException("No X509TrustManager available")
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(arrayOf(km), arrayOf<TrustManager>(tm), null)
            builder.sslSocketFactory(sslContext.socketFactory, tm)
        }

        val client = builder.build()
        cachedClient = client
        cachedClientForAlias = alias
        return client
    }

    private fun methodRequiresBody(method: String): Boolean = when (method.uppercase()) {
        "POST", "PUT", "PATCH", "DELETE" -> true
        else -> false
    }

    /**
     * X509ExtendedKeyManager that always returns the same KeyChain alias.
     * KeyChain.getPrivateKey / getCertificateChain are blocking; we call
     * them lazily on the OkHttp dispatcher thread, which is fine since the
     * fetch already runs off-main-thread.
     */
    private class KeyChainKeyManager(
        private val context: Context,
        private val alias: String,
    ) : X509ExtendedKeyManager() {

        override fun chooseClientAlias(
            keyTypes: Array<out String>?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String = alias

        override fun chooseEngineClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            engine: javax.net.ssl.SSLEngine?,
        ): String = alias

        override fun getCertificateChain(alias: String?): Array<X509Certificate>? {
            return try {
                KeyChain.getCertificateChain(context, this.alias)
            } catch (e: Exception) {
                null
            }
        }

        override fun getPrivateKey(alias: String?): PrivateKey? {
            return try {
                KeyChain.getPrivateKey(context, this.alias)
            } catch (e: Exception) {
                null
            }
        }

        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> =
            arrayOf(alias)

        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> =
            emptyArray()

        override fun chooseServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? = null
    }

    companion object {
        const val MODULE_NAME = "BulwarkClientCert"
        private const val PREFS_NAME = "bulwark_client_cert"
        private const val PREF_ALIAS = "alias"
    }
}
