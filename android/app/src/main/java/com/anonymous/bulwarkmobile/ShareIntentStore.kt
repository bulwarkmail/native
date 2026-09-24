package com.anonymous.bulwarkmobile

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

// Process-wide holder for the most recent ACTION_SEND / ACTION_SEND_MULTIPLE
// intent (the system share sheet). MainActivity fills this on onCreate /
// onNewIntent; JS drains it via BulwarkFcm.getInitialShare or reacts to the
// live "app:share" event and opens the composer. `SENDTO mailto:` intents are
// rewritten into `VIEW mailto:` links instead (see rewriteSendToAsView).
object ShareIntentStore {
    @Volatile
    private var pending: SharePayload? = null

    fun consume(): SharePayload? {
        val value = pending
        pending = null
        return value
    }

    fun captureFromIntent(intent: Intent?, resolver: ContentResolver): SharePayload? {
        val action = intent?.action ?: return null
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(MAX_TEXT)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(512)
        val uris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND) {
            streamExtra(intent)?.let { uris.add(it) }
        } else {
            streamExtras(intent)?.let { uris.addAll(it) }
        }
        val type = intent.type

        if (text.isNullOrBlank() && uris.isEmpty()) return null
        val files = uris.mapIndexed { i, uri -> describe(resolver, uri, type, i) }
        val payload = SharePayload(
            text = text,
            subject = subject,
            uris = uris.map { it.toString() },
            mimeTypes = files.map { it.mimeType },
            names = files.map { it.name },
            sizes = files.map { it.size },
        )
        pending = payload
        // Clear so a later lifecycle event doesn't replay this share.
        intent.removeExtra(Intent.EXTRA_TEXT)
        intent.removeExtra(Intent.EXTRA_SUBJECT)
        intent.removeExtra(Intent.EXTRA_STREAM)
        intent.action = Intent.ACTION_MAIN
        return payload
    }

    // `SENDTO mailto:` is how most apps start an email, but React Native's
    // Linking only forwards VIEW intents, so the app opened on the inbox.
    // Turn it into the equivalent `VIEW mailto:` link, folding the recipient,
    // subject and text extras into the URI, so it reaches JS like any other
    // mailto link: Linking.getInitialURL on a cold start, the "url" event
    // while running. Must run before the intent is handed to React Native.
    fun rewriteSendToAsView(intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_SENDTO) return
        val data = intent.data ?: return
        if (!"mailto".equals(data.scheme, ignoreCase = true)) return

        val params = mutableListOf<String>()
        addressExtra(intent, Intent.EXTRA_EMAIL).forEach { params.add("to=${Uri.encode(it)}") }
        addressExtra(intent, Intent.EXTRA_CC).forEach { params.add("cc=${Uri.encode(it)}") }
        addressExtra(intent, Intent.EXTRA_BCC).forEach { params.add("bcc=${Uri.encode(it)}") }
        intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.let {
            params.add("subject=${Uri.encode(it.toString().take(512))}")
        }
        intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let {
            params.add("body=${Uri.encode(it.toString().take(MAX_TEXT))}")
        }

        val link = data.toString()
        val separator = if (link.contains('?')) "&" else "?"
        intent.action = Intent.ACTION_VIEW
        intent.data = if (params.isEmpty()) data else Uri.parse(link + separator + params.joinToString("&"))
    }

    // EXTRA_EMAIL/CC/BCC are documented as String[], but some apps put a
    // single String.
    private fun addressExtra(intent: Intent, key: String): List<String> =
        intent.getStringArrayExtra(key)?.filterNotNull() ?: listOfNotNull(intent.getStringExtra(key))

    private class SharedFile(val name: String, val mimeType: String, val size: Double)

    // Ask the provider for the file's real name, type and size: a MediaStore
    // URI ends in a bare row id ("1000000027") and SEND_MULTIPLE only carries
    // a wildcard type such as "image/*". Size is -1 when unknown.
    private fun describe(resolver: ContentResolver, uri: Uri, intentType: String?, index: Int): SharedFile {
        var displayName: String? = null
        var size = -1.0
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameColumn >= 0 && !cursor.isNull(nameColumn)) displayName = cursor.getString(nameColumn)
                    val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn).toDouble()
                }
            }
        } catch (_: Exception) {
            // Provider without OpenableColumns: fall back to the URI below.
        }
        val resolvedType = try {
            resolver.getType(uri)
        } catch (_: Exception) {
            null
        }
        val mimeType = resolvedType ?: intentType?.takeUnless { it.contains('*') } ?: ""
        val name = displayName?.takeIf { it.isNotBlank() } ?: fallbackName(uri, mimeType, index)
        return SharedFile(name, mimeType, size)
    }

    // Last path segment plus an extension for the MIME type, so the
    // recipient's mail client can still open the attachment.
    private fun fallbackName(uri: Uri, mimeType: String, index: Int): String {
        val base = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
            ?: "shared-${index + 1}"
        if (base.contains('.')) return base
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
        return if (extension.isNullOrEmpty()) base else "$base.$extension"
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }

    @Suppress("DEPRECATION")
    private fun streamExtras(intent: Intent): List<Uri>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }

    data class SharePayload(
        val text: String?,
        val subject: String?,
        val uris: List<String>,
        val mimeTypes: List<String>,
        val names: List<String>,
        val sizes: List<Double>,
    ) {
        fun toMap(): WritableMap = Arguments.createMap().apply {
            if (text != null) putString("text", text)
            if (subject != null) putString("subject", subject)
            putArray("uris", Arguments.fromList(uris))
            putArray("mimeTypes", Arguments.fromList(mimeTypes))
            putArray("names", Arguments.fromList(names))
            putArray("sizes", Arguments.fromList(sizes))
        }
    }

    // 1 MiB of shared text is plenty; anything bigger is an attachment.
    private const val MAX_TEXT = 1 * 1024 * 1024
}
