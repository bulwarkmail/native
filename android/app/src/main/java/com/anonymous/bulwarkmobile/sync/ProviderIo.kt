package com.anonymous.bulwarkmobile.sync

import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.OperationApplicationException
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.TransactionTooLargeException
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.SyncStateContract
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException

/**
 * Runs device sync's provider calls for one Android account of our type and
 * one authority: `query`, `applyBatch`, `readSyncState` and `readPhoto` of
 * `NativeModules.BulwarkDeviceSync`. [ScopePlanner] decides what may run; this
 * class only builds the calls and reads the answers.
 *
 * Every URI carries `caller_is_syncadapter=true` and the account
 * (CalendarProvider accepts no other query parameter), so writes neither set
 * DIRTY nor schedule upload syncs, and ContactsProvider filters data rows by
 * the account. The scope lookups are the exception: they read ids and owners
 * of rows of any account.
 *
 * The client is unstable: a provider process that dies fails the call instead
 * of taking this process (and the UI) with it. Call from a background thread;
 * close when done.
 */
class ProviderIo(context: Context, accountName: String, private val authority: String) : ScopeLookup, AutoCloseable {
    private val appContext: Context = context.applicationContext
    private val account: AccountRef
    private val client: ContentProviderClient

    init {
        if (authority !in DeviceSyncAccounts.AUTHORITIES) {
            throw ProviderRefusal(BatchFailure.SCOPE, "$authority is not a device sync authority")
        }
        account = AccountRef(accountName, DeviceSyncAccounts.accountType(appContext))
        client = appContext.contentResolver.acquireUnstableContentProviderClient(authority)
            ?: throw IllegalStateException("No content provider for $authority")
    }

    override fun close() {
        client.close()
    }

    // ── the bridge calls ────────────────────────────────────────

    /** `ProviderQuery` JSON in, `ProviderRows` JSON out. Throws [ProviderRefusal] or what the provider threw. */
    fun query(queryJson: String): String {
        val plan = ScopePlanner(account, this).planQuery(ProviderOpParser.parseQuery(authority, queryJson))
        val writer = ProviderRowsWriter(plan.columns)
        val projection = plan.columns.toTypedArray()
        for (selection in plan.selections) {
            query(uri(plan.table), projection, selection, plan.orderBy).use { cursor ->
                while (cursor.moveToNext()) {
                    writer.beginRow()
                    for (i in projection.indices) {
                        when (cursor.getType(i)) {
                            Cursor.FIELD_TYPE_INTEGER -> writer.longCell(cursor.getLong(i))
                            Cursor.FIELD_TYPE_FLOAT -> writer.doubleCell(cursor.getDouble(i))
                            Cursor.FIELD_TYPE_STRING -> writer.textCell(cursor.getString(i))
                            // Blobs (photo thumbnails) never cross the bridge; readPhoto reads them.
                            else -> writer.nullCell()
                        }
                    }
                    writer.endRow()
                }
            }
        }
        return writer.finish()
    }

    /** `ProviderOp[]` JSON in, `BatchResult` JSON out. Never throws: failures are results. */
    fun applyBatch(opsJson: String): String = try {
        val ops = ProviderOpParser.parseBatch(authority, opsJson)
        // Rows written for an account that is gone would outlive it: the
        // providers purge an account's rows only when accounts change.
        if (!DeviceSyncAccounts.exists(appContext, account.name)) {
            throw ProviderRefusal(BatchFailure.SCOPE, "The account ${account.name} no longer exists")
        }
        if (ops.isEmpty()) {
            ProviderResults.ok(emptyList())
        } else {
            val planned = ScopePlanner(account, this).planBatch(ops)
            val results = client.applyBatch(ArrayList(planned.map(::build)))
            ProviderResults.ok(planned.zip(results) { op, result -> outcome(op, result.uri, result.count) })
        }
    } catch (e: Throwable) {
        ProviderResults.failed(failureOf(e), e.message ?: e.javaClass.simpleName)
    }

    /** The account's SyncState blob as text, or null when there is none. */
    fun readSyncState(): String? =
        SyncStateContract.Helpers.get(client, syncStateUri(), Account(account.name, account.type))
            ?.toString(Charsets.UTF_8)

    /**
     * The raw contact's display photo, or its thumbnail when it has none,
     * scaled so the longer side is at most [maxPx], as `PhotoData` JSON; null
     * when the raw contact has no photo.
     */
    fun readPhoto(rawContactId: Long, maxPx: Int): String? {
        require(authority == DeviceSyncAccounts.CONTACTS_AUTHORITY) { "Photos are contacts data" }
        require(maxPx > 0) { "maxPx must be positive" }
        if (rootAccounts(ProviderTable.RAW_CONTACTS, setOf(rawContactId))[rawContactId] != account) {
            throw ProviderRefusal(BatchFailure.SCOPE, "Raw contact $rawContactId is not part of the account")
        }
        var fileId: Long? = null
        var thumbnail: ByteArray? = null
        val photoRow = Selection(
            "raw_contact_id = ? AND mimetype = ?",
            listOf(rawContactId.toString(), ContactsContract.CommonDataKinds.Photo.CONTENT_ITEM_TYPE),
        )
        query(
            uri(ProviderTable.DATA),
            arrayOf(ContactsContract.CommonDataKinds.Photo.PHOTO_FILE_ID, ContactsContract.CommonDataKinds.Photo.PHOTO),
            photoRow,
            "${ContactsContract.Data.IS_PRIMARY} DESC",
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                if (!cursor.isNull(0)) fileId = cursor.getLong(0)
                if (cursor.getType(1) == Cursor.FIELD_TYPE_BLOB) thumbnail = cursor.getBlob(1)
            }
        }
        val bytes = readDisplayPhoto(rawContactId) ?: thumbnail ?: return null
        val jpeg = scaledJpeg(bytes, maxPx) ?: return null
        return JSONObject()
            .put("jpegBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
            .put("fileId", fileId ?: JSONObject.NULL)
            .toString()
    }

    private fun readDisplayPhoto(rawContactId: Long): ByteArray? {
        val uri = ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawContactId).buildUpon()
            .appendPath(ContactsContract.RawContacts.DisplayPhoto.CONTENT_DIRECTORY)
            .scoped()
            .build()
        return try {
            client.openAssetFile(uri, "r")?.use { fd -> fd.createInputStream().use { it.readBytes() } }
        } catch (e: FileNotFoundException) {
            // No display photo stored (small photos only have the thumbnail).
            null
        }
    }

    private fun scaledJpeg(bytes: ByteArray, maxPx: Int): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = PhotoScaling.sampleSize(bounds.outWidth, bounds.outHeight, maxPx)
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        val (width, height) = PhotoScaling.targetSize(decoded.width, decoded.height, maxPx)
        val scaled = if (width == decoded.width && height == decoded.height) {
            decoded
        } else {
            Bitmap.createScaledBitmap(decoded, width, height, true)
        }
        return ByteArrayOutputStream().use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            out.toByteArray()
        }
    }

    // ── ScopeLookup ─────────────────────────────────────────────

    override fun ownCalendarIds(): Set<Long> {
        val ids = HashSet<Long>()
        val selection = Selection(
            "${ScopePlanner.ACCOUNT_NAME} = ? AND ${ScopePlanner.ACCOUNT_TYPE} = ?",
            listOf(account.name, account.type),
        )
        query(uri(ProviderTable.CALENDARS), arrayOf(ID), selection, null).use { c ->
            while (c.moveToNext()) ids += c.getLong(0)
        }
        return ids
    }

    override fun rootAccounts(table: ProviderTable, ids: Set<Long>): Map<Long, AccountRef> {
        val owners = HashMap<Long, AccountRef>()
        forEachRow(table, arrayOf(ID, ScopePlanner.ACCOUNT_NAME, ScopePlanner.ACCOUNT_TYPE), ID, ids) { c ->
            owners[c.getLong(0)] = AccountRef(c.getString(1).orEmpty(), c.getString(2).orEmpty())
        }
        return owners
    }

    override fun dataRawContacts(ids: Set<Long>): Map<Long, Long> =
        idPairs(ProviderTable.DATA, "raw_contact_id", ids)

    override fun dataMimetypes(ids: Set<Long>): Map<Long, String> {
        val mimetypes = HashMap<Long, String>()
        forEachRow(ProviderTable.DATA, arrayOf(ID, "mimetype"), ID, ids) { c ->
            if (!c.isNull(1)) mimetypes[c.getLong(0)] = c.getString(1)
        }
        return mimetypes
    }

    override fun eventCalendars(ids: Set<Long>): Map<Long, Long> =
        idPairs(ProviderTable.EVENTS, "calendar_id", ids)

    override fun childEvents(table: ProviderTable, ids: Set<Long>): Map<Long, Long> =
        idPairs(table, "event_id", ids)

    override fun childEventIdsMatching(table: ProviderTable, where: String?, args: List<String>): Set<Long> {
        val events = HashSet<Long>()
        query(uri(table, scoped = false), arrayOf("event_id"), Selection(where, args), null).use { c ->
            while (c.moveToNext()) if (!c.isNull(0)) events += c.getLong(0)
        }
        return events
    }

    /** Row id → [column] for the rows of [ids] that exist, in any account. */
    private fun idPairs(table: ProviderTable, column: String, ids: Set<Long>): Map<Long, Long> {
        val pairs = HashMap<Long, Long>()
        forEachRow(table, arrayOf(ID, column), table.idColumn!!, ids) { c ->
            if (!c.isNull(1)) pairs[c.getLong(0)] = c.getLong(1)
        }
        return pairs
    }

    private fun forEachRow(
        table: ProviderTable,
        projection: Array<String>,
        idColumn: String,
        ids: Set<Long>,
        read: (Cursor) -> Unit,
    ) {
        for (chunk in ids.chunked(ScopePlanner.ID_LIST_CHUNK)) {
            val selection = Selection(ScopePlanner.idList(idColumn, chunk), emptyList())
            query(uri(table, scoped = false), projection, selection, null).use { c ->
                while (c.moveToNext()) read(c)
            }
        }
    }

    private fun query(uri: Uri, projection: Array<String>, selection: Selection, orderBy: String?): Cursor =
        client.query(uri, projection, selection.sql, selection.args.toTypedArray(), orderBy)
            ?: throw IllegalStateException("$authority returned no cursor for $uri")

    // ── operations ──────────────────────────────────────────────

    private fun build(op: PlannedOp): ContentProviderOperation = when (op) {
        is PlannedOp.Insert -> ContentProviderOperation.newInsert(uri(op.table))
            .withValues(contentValues(op.values))
            .apply { for ((column, index) in op.backReferences) withValueBackReference(column, index) }
            .withYieldAllowed(op.yieldAllowed)
            .build()
        is PlannedOp.Update -> ContentProviderOperation
            .newUpdate(op.itemId?.let { uri(op.table, itemId = it) } ?: uri(op.table))
            .withValues(contentValues(op.values))
            .selectRows(op.selection)
            .expectRows(op.expectedCount)
            .withYieldAllowed(op.yieldAllowed)
            .build()
        is PlannedOp.Delete -> ContentProviderOperation.newDelete(uri(op.table))
            .selectRows(op.selection)
            .expectRows(op.expectedCount)
            .withYieldAllowed(op.yieldAllowed)
            .build()
        is PlannedOp.Assert -> ContentProviderOperation.newAssertQuery(uri(op.table))
            .selectRows(op.selection)
            .apply {
                op.values?.let { values ->
                    withValues(ContentValues().apply { for ((column, text) in values) put(column, text) })
                }
            }
            .expectRows(op.expectedCount)
            .withYieldAllowed(op.yieldAllowed)
            .build()
        // An insert that replaces the account's row; never a yield point.
        is PlannedOp.SetSyncState -> SyncStateContract.Helpers.newSetOperation(
            syncStateUri(),
            Account(account.name, account.type),
            op.value.toByteArray(Charsets.UTF_8),
        )
    }

    private fun ContentProviderOperation.Builder.selectRows(selection: Selection) = apply {
        // An item URI takes no selection at all (CalendarProvider refuses one).
        if (selection.sql != null) withSelection(selection.sql, selection.args.toTypedArray())
    }

    private fun ContentProviderOperation.Builder.expectRows(count: Int?) = apply {
        if (count != null) withExpectedCount(count)
    }

    private fun outcome(op: PlannedOp, uri: Uri?, count: Int?): OpOutcome = when (op) {
        // Settings inserts answer with the account's URI, which has no id.
        is PlannedOp.Insert -> OpOutcome(id = uri?.lastPathSegment?.toLongOrNull())
        is PlannedOp.SetSyncState -> OpOutcome()
        else -> OpOutcome(count = count)
    }

    private fun contentValues(values: Map<String, Cell>) = ContentValues(values.size).apply {
        for ((column, cell) in values) {
            when (cell) {
                is Cell.Text -> put(column, cell.value)
                is Cell.Integer -> put(column, cell.value)
                is Cell.Real -> put(column, cell.value)
                is Cell.Blob -> put(column, decodeBlob(column, cell.base64))
                Cell.Null -> putNull(column)
            }
        }
    }

    private fun decodeBlob(column: String, base64: String): ByteArray = try {
        Base64.decode(base64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
        throw ProviderRefusal(BatchFailure.PROVIDER, "$column is not base64")
    }

    // ── URIs ────────────────────────────────────────────────────

    private fun uri(table: ProviderTable, itemId: Long? = null, scoped: Boolean = true): Uri {
        val base = when (table) {
            ProviderTable.RAW_CONTACTS -> ContactsContract.RawContacts.CONTENT_URI
            ProviderTable.DATA -> ContactsContract.Data.CONTENT_URI
            ProviderTable.GROUPS -> ContactsContract.Groups.CONTENT_URI
            ProviderTable.SETTINGS -> ContactsContract.Settings.CONTENT_URI
            ProviderTable.CALENDARS -> CalendarContract.Calendars.CONTENT_URI
            ProviderTable.EVENTS -> CalendarContract.Events.CONTENT_URI
            ProviderTable.ATTENDEES -> CalendarContract.Attendees.CONTENT_URI
            ProviderTable.REMINDERS -> CalendarContract.Reminders.CONTENT_URI
            ProviderTable.EXTENDED_PROPERTIES -> CalendarContract.ExtendedProperties.CONTENT_URI
            ProviderTable.COLORS -> CalendarContract.Colors.CONTENT_URI
        }
        val builder = (itemId?.let { ContentUris.withAppendedId(base, it) } ?: base).buildUpon()
        return if (scoped) builder.scoped().build() else builder.syncAdapter().build()
    }

    private fun syncStateUri(): Uri = when (authority) {
        DeviceSyncAccounts.CONTACTS_AUTHORITY -> ContactsContract.SyncState.CONTENT_URI
        else -> CalendarContract.SyncState.CONTENT_URI
    }.buildUpon().scoped().build()

    private fun Uri.Builder.syncAdapter() = appendQueryParameter(CALLER_IS_SYNCADAPTER, "true")

    private fun Uri.Builder.scoped() = syncAdapter()
        .appendQueryParameter(ScopePlanner.ACCOUNT_NAME, account.name)
        .appendQueryParameter(ScopePlanner.ACCOUNT_TYPE, account.type)

    companion object {
        private const val ID = "_id"
        private const val JPEG_QUALITY = 85

        /** Same parameter name in ContactsContract and CalendarContract. */
        private const val CALLER_IS_SYNCADAPTER = ContactsContract.CALLER_IS_SYNCADAPTER

        /** The `BatchFailure` of an exception from planning or from the provider (possibly wrapped). */
        fun failureOf(e: Throwable): BatchFailure {
            var t: Throwable? = e
            while (t != null) {
                when (t) {
                    is ProviderRefusal -> return t.reason
                    is TransactionTooLargeException -> return BatchFailure.TOO_LARGE
                    is SecurityException -> return BatchFailure.PERMISSION
                    is OperationApplicationException -> return ProviderResults.failureOfOperationApplication(t.message)
                }
                t = t.cause?.takeIf { it !== t }
            }
            return BatchFailure.PROVIDER
        }
    }
}
