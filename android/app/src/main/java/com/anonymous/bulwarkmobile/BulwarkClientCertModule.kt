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
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocketFactory
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
 *   2. `fetchSecure` — a fetch shim built on `HttpsURLConnection` that
 *      injects the picked cert into the TLS handshake. JS-side `fetch`
 *      can't present a client cert because RN's bundled OkHttp client
 *      doesn't expose its KeyManager hook to userland; this method is
 *      the workaround.
 */
class BulwarkClientCertModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Volatile private var cachedAlias: String? = prefs.getString(PREF_ALIAS, null)
    @Volatile private var cachedFactory: SSLSocketFactory? = null
    @Volatile private var cachedFactoryForAlias: String? = null

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
        invalidateFactory()
        promise.resolve(null)
    }

    /**
     * Show the system "Choose a certificate" picker. Resolves with the
     * selected alias, or `null` when the user dismisses the picker.
     */
    @ReactMethod
    fun pickAlias(host: String?, promise: Promise) {
        // ReactContextBaseJavaModule no longer exposes a Kotlin synthetic
        // `currentActivity` property in RN 0.80+ (compiles as an unresolved
        // reference). The explicit Java-style getter on the application
        // context is the supported call site.
        val activity: android.app.Activity? = reactApplicationContext.getCurrentActivity()
        if (activity == null) {
            promise.reject("no_activity", "No current activity to host the cert picker")
            return
        }
        val callback = KeyChainAliasCallback { alias ->
            // Callback runs off the main thread; persist + resolve directly.
            if (alias.isNullOrBlank()) {
                promise.resolve(null)
                return@KeyChainAliasCallback
            }
            prefs.edit().putString(PREF_ALIAS, alias).apply()
            cachedAlias = alias
            invalidateFactory()
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
        val method = (request.getString("method") ?: "GET").uppercase()
        val timeoutMs = if (request.hasKey("timeoutMs")) request.getInt("timeoutMs") else 30_000
        val headersMap = request.getMap("headers")
        val bodyBase64 = request.getString("bodyBase64")
        val bodyBytes = bodyBase64?.let { Base64.decode(it, Base64.NO_WRAP) }

        thread(name = "BulwarkClientCert.fetch") {
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    requestMethod = method
                    instanceFollowRedirects = true
                    if (bodyBytes != null) {
                        doOutput = true
                        setFixedLengthStreamingMode(bodyBytes.size)
                    }
                }
                if (conn is HttpsURLConnection && cachedAlias != null) {
                    conn.sslSocketFactory = buildOrReuseSocketFactory()
                }
                headersMap?.let { h ->
                    val it = h.keySetIterator()
                    while (it.hasNextKey()) {
                        val k = it.nextKey()
                        val v = h.getString(k)
                        if (v != null) conn.setRequestProperty(k, v)
                    }
                }
                conn.connect()
                if (bodyBytes != null) {
                    conn.outputStream.use { out -> out.write(bodyBytes) }
                }

                val status = conn.responseCode
                val statusText = conn.responseMessage ?: ""
                val responseStream = try {
                    conn.inputStream
                } catch (_: Exception) {
                    conn.errorStream
                }
                val responseBytes = if (responseStream != null) {
                    val buf = ByteArrayOutputStream()
                    responseStream.copyTo(buf)
                    responseStream.close()
                    buf.toByteArray()
                } else {
                    ByteArray(0)
                }

                val out = Arguments.createMap()
                out.putInt("status", status)
                out.putString("statusText", statusText)
                val headers = Arguments.createMap()
                // headerFields is a `Map<String?, List<String>>`; the null
                // key is the HTTP status line, which we don't need to copy.
                for ((name, values) in conn.headerFields) {
                    if (name == null || values == null) continue
                    headers.putString(name, values.joinToString(", "))
                }
                out.putMap("headers", headers)
                out.putString("bodyBase64", Base64.encodeToString(responseBytes, Base64.NO_WRAP))
                conn.disconnect()
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("fetch_failed", e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    // ── internals ───────────────────────────────────────────────

    private fun invalidateFactory() {
        cachedFactory = null
        cachedFactoryForAlias = null
    }

    private fun buildOrReuseSocketFactory(): SSLSocketFactory {
        val alias = cachedAlias ?: throw IllegalStateException("No client-cert alias selected")
        val existing = cachedFactory
        if (existing != null && cachedFactoryForAlias == alias) return existing

        val ctx = reactApplicationContext
        val km = KeyChainKeyManager(ctx, alias)
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        val trustManagers = tmf.trustManagers
        val tm = trustManagers.firstOrNull { it is X509TrustManager } as X509TrustManager?
            ?: throw IllegalStateException("No X509TrustManager available")
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(arrayOf(km), arrayOf<TrustManager>(tm), null)
        val factory = sslContext.socketFactory
        cachedFactory = factory
        cachedFactoryForAlias = alias
        return factory
    }

    /**
     * X509ExtendedKeyManager that always returns the same KeyChain alias.
     * KeyChain.getPrivateKey / getCertificateChain are blocking; we call
     * them lazily during the TLS handshake, which is fine since the
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
            engine: SSLEngine?,
        ): String = alias

        override fun getCertificateChain(alias: String?): Array<X509Certificate>? {
            return try {
                KeyChain.getCertificateChain(context, this.alias)
            } catch (_: Exception) {
                null
            }
        }

        override fun getPrivateKey(alias: String?): PrivateKey? {
            return try {
                KeyChain.getPrivateKey(context, this.alias)
            } catch (_: Exception) {
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
