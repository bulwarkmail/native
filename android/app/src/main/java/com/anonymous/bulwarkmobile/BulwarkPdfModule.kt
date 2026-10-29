package com.anonymous.bulwarkmobile

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Renders PDF pages to PNG files for the in-app file preview, with the
 * platform's own PdfRenderer: Android has no PDF view, and its WebView
 * doesn't show PDFs either. The preview draws the pages in a WebView of
 * its own so they zoom, asking for each page as it scrolls into view.
 *
 * PdfRenderer is not thread-safe and allows one open page at a time, so
 * every call runs on one background thread, and the open document is kept
 * between calls for the file the preview shows.
 */
class BulwarkPdfModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "BulwarkPdf").apply { isDaemon = true } }
    private var openPath: String? = null
    private var descriptor: ParcelFileDescriptor? = null
    private var renderer: PdfRenderer? = null

    override fun getName(): String = "BulwarkPdf"

    override fun invalidate() {
        worker.execute { closeDocument() }
        worker.shutdown()
        super.invalidate()
    }

    /** Page count and each page's size in points: `{ pages: [{ width, height }] }`. */
    @ReactMethod
    fun open(fileUri: String, promise: Promise) {
        worker.execute {
            try {
                val doc = document(fileUri)
                val pages = Arguments.createArray()
                for (i in 0 until doc.pageCount) {
                    doc.openPage(i).use { page ->
                        pages.pushMap(Arguments.createMap().apply {
                            putInt("width", page.width)
                            putInt("height", page.height)
                        })
                    }
                }
                promise.resolve(Arguments.createMap().apply { putArray("pages", pages) })
            } catch (e: SecurityException) {
                // Password-protected; PdfRenderer can't open those.
                closeDocument()
                promise.reject("E_PDF_PROTECTED", e.message, e)
            } catch (e: Throwable) {
                closeDocument()
                promise.reject("E_PDF_OPEN", e.message, e)
            }
        }
    }

    /** Render one page `width` pixels wide into `outUri` (a PNG). Resolves with the file URI. */
    @ReactMethod
    fun renderPage(fileUri: String, index: Int, width: Int, outUri: String, promise: Promise) {
        worker.execute {
            try {
                val doc = document(fileUri)
                if (index < 0 || index >= doc.pageCount) throw IndexOutOfBoundsException("page $index")
                doc.openPage(index).use { page ->
                    val w = width.coerceIn(1, MAX_PAGE_PX)
                    val h = (w.toLong() * page.height / page.width.coerceAtLeast(1)).toInt().coerceIn(1, MAX_PAGE_PX * 2)
                    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    try {
                        // Pages are transparent where nothing is drawn.
                        bitmap.eraseColor(Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        val out = fileOf(outUri)
                        // The preview's folder is gone once it closed; a page
                        // still queued then must not bring it back.
                        if (out.parentFile?.isDirectory != true) throw IllegalStateException("preview closed")
                        FileOutputStream(out).use { stream -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream) }
                    } finally {
                        bitmap.recycle()
                    }
                }
                promise.resolve(outUri)
            } catch (e: Throwable) {
                promise.reject("E_PDF_RENDER", e.message, e)
            }
        }
    }

    /** Close the document the preview showed. */
    @ReactMethod
    fun close(fileUri: String, promise: Promise) {
        worker.execute {
            if (openPath == fileOf(fileUri).absolutePath) closeDocument()
            promise.resolve(null)
        }
    }

    private fun document(fileUri: String): PdfRenderer {
        val path = fileOf(fileUri).absolutePath
        renderer?.let { if (openPath == path) return it }
        closeDocument()
        val fd = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        try {
            val doc = PdfRenderer(fd)
            descriptor = fd
            renderer = doc
            openPath = path
            return doc
        } catch (e: Throwable) {
            fd.close()
            throw e
        }
    }

    private fun closeDocument() {
        try { renderer?.close() } catch (_: Throwable) {}
        try { descriptor?.close() } catch (_: Throwable) {}
        renderer = null
        descriptor = null
        openPath = null
    }

    private fun fileOf(uri: String): File {
        val path = if (uri.startsWith("file:")) Uri.parse(uri).path else uri
        return File(path ?: throw IllegalArgumentException("not a file: $uri"))
    }

    companion object {
        // A 4096 px page bitmap is 64 MB; keep well below.
        private const val MAX_PAGE_PX = 2480
    }
}
