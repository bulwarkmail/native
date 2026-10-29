package com.anonymous.bulwarkmobile.sync

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger
import kotlin.math.abs

/**
 * The provider operations of device sync (#34) as the engine sends them: the
 * `ProviderQuery` and `ProviderOp[]` JSON of src/device-sync/types.ts, parsed
 * into a validated model. [ScopePlanner] turns the model into provider calls
 * scoped to one account and [ProviderIo] runs them. Nothing here touches
 * Android types, so JVM tests cover all of it.
 */

/** `BatchFailure` of types.ts: why a batch was refused or failed. */
enum class BatchFailure(val wire: String) {
    ASSERT("assert"),
    TOO_LARGE("tooLarge"),
    SCOPE("scope"),
    PERMISSION("permission"),
    PROVIDER("provider"),
}

/** A query or batch refused before it reached the provider. */
class ProviderRefusal(val reason: BatchFailure, message: String) : Exception(message)

/** How the rows of a table are tied to an account; see [ScopePlanner]. */
enum class TableScope { ACCOUNT_COLUMNS, URI_PARAMETERS, CALENDAR_IDS, EVENT_IDS }

/** The tables the engine may touch, per authority. Any other table is refused. */
enum class ProviderTable(
    val wire: String,
    val authority: String,
    val scope: TableScope,
    /** The table whose row each row here belongs to, named by [parentColumn]. */
    val parent: ProviderTable? = null,
    val parentColumn: String? = null,
    /**
     * How a selection names the row id; null when rows have none (Settings
     * rows are keyed by their account). CalendarProvider queries attendees
     * joined with events and calendars, where a bare `_id` is ambiguous.
     */
    val idColumn: String? = "_id",
) {
    RAW_CONTACTS("raw_contacts", DeviceSyncAccounts.CONTACTS_AUTHORITY, TableScope.ACCOUNT_COLUMNS),
    DATA("data", DeviceSyncAccounts.CONTACTS_AUTHORITY, TableScope.URI_PARAMETERS, RAW_CONTACTS, "raw_contact_id"),
    GROUPS("groups", DeviceSyncAccounts.CONTACTS_AUTHORITY, TableScope.ACCOUNT_COLUMNS),
    SETTINGS("settings", DeviceSyncAccounts.CONTACTS_AUTHORITY, TableScope.ACCOUNT_COLUMNS, idColumn = null),
    CALENDARS("calendars", DeviceSyncAccounts.CALENDAR_AUTHORITY, TableScope.ACCOUNT_COLUMNS),
    EVENTS("events", DeviceSyncAccounts.CALENDAR_AUTHORITY, TableScope.CALENDAR_IDS, CALENDARS, "calendar_id"),
    ATTENDEES(
        "attendees", DeviceSyncAccounts.CALENDAR_AUTHORITY, TableScope.EVENT_IDS, EVENTS, "event_id", "Attendees._id",
    ),
    REMINDERS(
        "reminders", DeviceSyncAccounts.CALENDAR_AUTHORITY, TableScope.EVENT_IDS, EVENTS, "event_id", "Reminders._id",
    ),
    EXTENDED_PROPERTIES(
        "extended_properties",
        DeviceSyncAccounts.CALENDAR_AUTHORITY,
        TableScope.EVENT_IDS,
        EVENTS,
        "event_id",
        "ExtendedProperties._id",
    ),
    COLORS("colors", DeviceSyncAccounts.CALENDAR_AUTHORITY, TableScope.ACCOUNT_COLUMNS),
    ;

    /** An insert returns the new row id, which later ops can back-reference. */
    val insertReturnsId: Boolean get() = idColumn != null

    companion object {
        fun of(authority: String, wire: String): ProviderTable =
            entries.firstOrNull { it.wire == wire && it.authority == authority }
                ?: throw ProviderRefusal(BatchFailure.SCOPE, "Table $wire is not part of $authority")
    }
}

/**
 * A cell as it crosses the bridge: text, a number, null, or (written to
 * `data.data15` only) photo bytes as base64. Numbers that are integers become
 * [Integer], so an assert compares `5` with the provider's `5`, not `5.0`.
 */
sealed interface Cell {
    data class Text(val value: String) : Cell
    data class Integer(val value: Long) : Cell
    data class Real(val value: Double) : Cell
    data class Blob(val base64: String) : Cell
    data object Null : Cell

    /** The text ContentProviderOperation compares an assert with; blobs never reach an assert. */
    fun text(): String? = when (this) {
        is Text -> value
        is Integer -> value.toString()
        is Real -> value.toString()
        is Blob -> throw IllegalStateException("Blobs have no text form")
        Null -> null
    }

    /** The row id this cell names, if it names one (`12` or `"12"`). */
    fun rowId(): Long? = when (this) {
        is Integer -> value
        is Text -> value.toLongOrNull()
        else -> null
    }
}

/** Which rows an update, delete or assert addresses: one row by id, a `where` set, or the id row if it matches. */
data class RowTarget(val id: Long?, val where: String?, val args: List<String>)

data class ProviderQuery(
    val table: ProviderTable,
    val columns: List<String>,
    val where: String?,
    val args: List<String>,
    val orderBy: String?,
)

/** One `ProviderOp` of types.ts, validated. */
sealed interface ProviderOp {
    val yieldAllowed: Boolean

    data class Insert(
        val table: ProviderTable,
        val values: Map<String, Cell>,
        /** Column → index of an earlier insert of the batch whose new row id fills it. */
        val refs: Map<String, Int>,
        override val yieldAllowed: Boolean,
    ) : ProviderOp

    data class Update(
        val table: ProviderTable,
        val target: RowTarget,
        val values: Map<String, Cell>,
        val expectCount: Int?,
        override val yieldAllowed: Boolean,
    ) : ProviderOp

    data class Delete(
        val table: ProviderTable,
        val target: RowTarget,
        val expectCount: Int?,
        override val yieldAllowed: Boolean,
    ) : ProviderOp

    data class Assert(
        val table: ProviderTable,
        val target: RowTarget,
        val values: Map<String, Cell>?,
        val expectCount: Int?,
        override val yieldAllowed: Boolean,
    ) : ProviderOp

    data class SetSyncState(val value: String, override val yieldAllowed: Boolean) : ProviderOp
}

const val GROUP_MEMBERSHIP_MIMETYPE = "vnd.android.cursor.item/group_membership"

/**
 * Checks a selection or sort order before the account's scope is ANDed onto
 * it as `(text) AND (scope)`: its parentheses must balance outside quoted
 * literals, or `1) OR (1` would close the scope's own parenthesis. It may
 * not end or comment out the statement, nor query other tables. The engine's
 * selections are constants with `?` arguments; this guards against bugs.
 */
object SqlFragments {
    private val FORBIDDEN_WORDS = Regex("\\b(SELECT|UNION|ATTACH|DETACH|PRAGMA)\\b", RegexOption.IGNORE_CASE)

    fun check(text: String, what: String) {
        var depth = 0
        var quote: Char? = null
        val outside = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (quote != null) {
                if (c == quote) {
                    // A doubled quote is an escaped one inside the literal.
                    if (i + 1 < text.length && text[i + 1] == quote) i++ else quote = null
                }
                outside.append(' ')
            } else {
                when (c) {
                    '\'', '"' -> {
                        quote = c
                        outside.append(' ')
                    }
                    '(' -> {
                        depth++
                        outside.append(c)
                    }
                    ')' -> {
                        if (--depth < 0) refuse(what, "closes a parenthesis it did not open")
                        outside.append(c)
                    }
                    ';' -> refuse(what, "ends the statement")
                    '\u0000' -> refuse(what, "contains a NUL character")
                    else -> outside.append(c)
                }
            }
            i++
        }
        if (quote != null) refuse(what, "leaves a quote open")
        if (depth != 0) refuse(what, "leaves a parenthesis open")
        val bare = outside.toString()
        if ("--" in bare || "/*" in bare) refuse(what, "contains a comment")
        FORBIDDEN_WORDS.find(bare)?.let { refuse(what, "uses ${it.value.uppercase()}") }
    }

    private fun refuse(what: String, why: String): Nothing =
        throw ProviderRefusal(BatchFailure.SCOPE, "$what $why")
}

/**
 * The table a written column points into when the row it names must belong to
 * the account as well: the parent of a row, the master of an exception event,
 * the group of a membership row.
 */
internal fun referencedTable(table: ProviderTable, column: String, values: Map<String, Cell>): ProviderTable? = when {
    column == table.parentColumn -> table.parent
    table == ProviderTable.EVENTS && column == "original_id" -> ProviderTable.EVENTS
    table == ProviderTable.DATA && column == "data1" &&
        values["mimetype"] == Cell.Text(GROUP_MEMBERSHIP_MIMETYPE) -> ProviderTable.GROUPS
    else -> null
}

object ProviderOpParser {
    /**
     * ContactsProvider throws when its op counter reaches this. It counts an
     * op before resetting at a yield point, so at most 499 ops may follow a
     * yield point up to and including the next one.
     */
    const val CONTACTS_OPS_PER_YIELD_POINT = 500

    /** JS numbers beyond this are not exact integers any more. */
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

    fun parseQuery(authority: String, json: String): ProviderQuery {
        val o = parseObject(json, "query")
        val table = ProviderTable.of(authority, o.requireString("table"))
        val rawColumns = o.opt("columns") as? JSONArray ?: throw invalid("query needs a columns array")
        val columns = (0 until rawColumns.length()).map { i ->
            rawColumns.opt(i) as? String ?: throw invalid("columns[$i] must be a string")
        }
        if (columns.isEmpty()) throw invalid("query needs at least one column")
        val (where, args) = o.whereArgs("query")
        val orderBy = o.optionalString("orderBy")?.also { SqlFragments.check(it, "query: orderBy") }
        return ProviderQuery(table, columns, where, args, orderBy)
    }

    fun parseBatch(authority: String, json: String): List<ProviderOp> {
        val array = try {
            JSONArray(json)
        } catch (e: JSONException) {
            throw invalid("ops are not a JSON array: ${e.message}")
        }
        val ops = (0 until array.length()).map { i ->
            val o = array.opt(i) as? JSONObject ?: throw invalid("op $i is not an object")
            parseOp(authority, i, o)
        }
        checkSyncState(ops)
        checkBackReferences(ops)
        if (authority == DeviceSyncAccounts.CONTACTS_AUTHORITY) checkYieldPoints(ops)
        return ops
    }

    private fun parseOp(authority: String, index: Int, o: JSONObject): ProviderOp {
        val where = "op $index"
        val kind = o.opt("op") as? String ?: throw invalid("$where has no op")
        val yieldAllowed = o.optBoolean("yieldAllowed", false)
        if (kind == "syncState") {
            val value = o.opt("value") as? String ?: throw invalid("$where: syncState needs a string value")
            return ProviderOp.SetSyncState(value, yieldAllowed)
        }
        val table = ProviderTable.of(authority, o.requireString("table"))
        return when (kind) {
            "insert" -> ProviderOp.Insert(table, o.writeValues(table, where), o.refs(where), yieldAllowed)
            "update" -> {
                val values = o.writeValues(table, where)
                if (values.isEmpty()) throw invalid("$where: an update needs values")
                ProviderOp.Update(table, o.target(table, where), values, o.expectCount(where), yieldAllowed)
            }
            "delete" -> ProviderOp.Delete(table, o.target(table, where), o.expectCount(where), yieldAllowed)
            "assert" -> {
                val target = o.target(table, where)
                val values = o.assertValues(where)
                val expectCount = o.expectCount(where)
                if (values.isNullOrEmpty() && expectCount == null && target.id == null) {
                    throw invalid("$where: an assert needs values, an expected count or an id")
                }
                ProviderOp.Assert(table, target, values?.takeIf { it.isNotEmpty() }, expectCount, yieldAllowed)
            }
            else -> throw invalid("$where: unknown op $kind")
        }
    }

    /**
     * The state describes the rows of its batch, so it must commit with them:
     * as the last op, and not at a yield point, where the provider may commit
     * everything before it on its own.
     */
    private fun checkSyncState(ops: List<ProviderOp>) {
        ops.forEachIndexed { i, op ->
            if (op !is ProviderOp.SetSyncState) return@forEachIndexed
            if (i != ops.lastIndex) {
                throw ProviderRefusal(BatchFailure.SCOPE, "op $i: syncState must be the last op of its batch")
            }
            if (op.yieldAllowed) throw ProviderRefusal(BatchFailure.SCOPE, "op $i: syncState must not be a yield point")
        }
    }

    private fun checkBackReferences(ops: List<ProviderOp>) {
        ops.forEachIndexed { i, op ->
            if (op !is ProviderOp.Insert) return@forEachIndexed
            for ((column, ref) in op.refs) {
                val target = ops.getOrNull(ref)
                if (ref >= i || target !is ProviderOp.Insert || !target.table.insertReturnsId) {
                    throw invalid("op $i: $column refers to op $ref, which is not an earlier insert with a row id")
                }
                val expected = referencedTable(op.table, column, op.values)
                if (expected != null && target.table != expected) {
                    throw ProviderRefusal(
                        BatchFailure.SCOPE,
                        "op $i: $column must refer to a ${expected.wire} insert, not ${target.table.wire}",
                    )
                }
            }
            val parentColumn = op.table.parentColumn ?: return@forEachIndexed
            val named = parentColumn in op.refs || (op.values[parentColumn] ?: Cell.Null) != Cell.Null
            if (!named) {
                throw ProviderRefusal(BatchFailure.SCOPE, "op $i: a ${op.table.wire} insert must name its $parentColumn")
            }
        }
    }

    private fun checkYieldPoints(ops: List<ProviderOp>) {
        var count = 0
        ops.forEachIndexed { i, op ->
            if (++count >= CONTACTS_OPS_PER_YIELD_POINT) {
                throw invalid(
                    "op $i: more than ${CONTACTS_OPS_PER_YIELD_POINT - 1} ops without a yield point " +
                        "(ContactsProvider refuses the batch)",
                )
            }
            if (i > 0 && op.yieldAllowed) count = 0
        }
    }

    // ── JSON helpers ────────────────────────────────────────────

    private fun invalid(message: String) = ProviderRefusal(BatchFailure.PROVIDER, message)

    private fun parseObject(json: String, what: String): JSONObject = try {
        JSONObject(json)
    } catch (e: JSONException) {
        throw invalid("$what is not a JSON object: ${e.message}")
    }

    private fun JSONObject.requireString(key: String): String =
        opt(key) as? String ?: throw invalid("$key must be a string")

    private fun JSONObject.optionalString(key: String): String? = when (val v = opt(key)) {
        null, JSONObject.NULL -> null
        is String -> v.takeIf { it.isNotBlank() }
        else -> throw invalid("$key must be a string")
    }

    private fun JSONObject.target(table: ProviderTable, where: String): RowTarget {
        val id = when (val raw = opt("id")) {
            null, JSONObject.NULL -> null
            else -> (scalar(raw, "$where: id") as? Cell.Integer)?.value?.takeIf { it >= 0 }
                ?: throw invalid("$where: id must be a row id")
        }
        if (id != null && table.idColumn == null) throw invalid("$where: ${table.wire} rows have no id")
        val (sql, args) = whereArgs(where)
        return RowTarget(id, sql, args)
    }

    private fun JSONObject.whereArgs(where: String): Pair<String?, List<String>> {
        val sql = optionalString("where")?.also { SqlFragments.check(it, "$where: where") }
        val args = when (val raw = opt("args")) {
            null, JSONObject.NULL -> emptyList()
            is JSONArray -> (0 until raw.length()).map { i ->
                scalar(raw.opt(i), "$where: args[$i]").text()
                    ?: throw invalid("$where: args[$i] must be a string or a number")
            }
            else -> throw invalid("$where: args must be an array")
        }
        if (sql == null && args.isNotEmpty()) throw invalid("$where: args without a where")
        return sql to args
    }

    private fun JSONObject.expectCount(where: String): Int? = when (val raw = opt("expectCount")) {
        null, JSONObject.NULL -> null
        else -> (scalar(raw, "$where: expectCount") as? Cell.Integer)?.value
            ?.takeIf { it in 0..Int.MAX_VALUE }?.toInt()
            ?: throw invalid("$where: expectCount must be a count")
    }

    private fun JSONObject.refs(where: String): Map<String, Int> {
        val raw = opt("refs") ?: return emptyMap()
        if (raw == JSONObject.NULL) return emptyMap()
        if (raw !is JSONObject) throw invalid("$where: refs must be an object")
        val out = LinkedHashMap<String, Int>()
        for (column in raw.keys()) {
            val index = (scalar(raw.opt(column), "$where: refs.$column") as? Cell.Integer)?.value
                ?.takeIf { it in 0..Int.MAX_VALUE }
                ?: throw invalid("$where: refs.$column must be an op index")
            out[column] = index.toInt()
        }
        return out
    }

    private fun JSONObject.writeValues(table: ProviderTable, where: String): Map<String, Cell> {
        val raw = opt("values") as? JSONObject ?: throw invalid("$where: values must be an object")
        val out = LinkedHashMap<String, Cell>()
        for (column in raw.keys()) {
            val v = raw.opt(column)
            out[column] = if (v is JSONObject) blob(table, column, v, where) else scalar(v, "$where: $column")
        }
        return out
    }

    private fun JSONObject.assertValues(where: String): Map<String, Cell>? {
        val raw = opt("values") ?: return null
        if (raw == JSONObject.NULL) return null
        if (raw !is JSONObject) throw invalid("$where: values must be an object")
        val out = LinkedHashMap<String, Cell>()
        for (column in raw.keys()) out[column] = scalar(raw.opt(column), "$where: $column")
        return out
    }

    /** Only photo rows carry bytes (`data.data15`); the provider stores and scales them itself. */
    private fun blob(table: ProviderTable, column: String, v: JSONObject, where: String): Cell.Blob {
        if (table != ProviderTable.DATA || column != "data15") {
            throw ProviderRefusal(BatchFailure.SCOPE, "$where: bytes are only accepted for data.data15, not ${table.wire}.$column")
        }
        val base64 = v.opt("b64") as? String ?: throw invalid("$where: $column needs { b64 }")
        return Cell.Blob(base64)
    }

    private fun scalar(v: Any?, what: String): Cell = when (v) {
        null, JSONObject.NULL -> Cell.Null
        is String -> Cell.Text(v)
        is Boolean -> Cell.Integer(if (v) 1 else 0)
        is Number -> numberCell(v)
        else -> throw invalid("$what must be text, a number or null")
    }

    /** org.json yields Integer, Long, Double, BigInteger or BigDecimal depending on the platform and the value. */
    internal fun numberCell(n: Number): Cell = when (n) {
        is Int, is Long, is Short, is Byte -> Cell.Integer(n.toLong())
        is BigInteger -> if (n.bitLength() < 64) Cell.Integer(n.toLong()) else Cell.Real(n.toDouble())
        is BigDecimal -> try {
            Cell.Integer(n.longValueExact())
        } catch (e: ArithmeticException) {
            Cell.Real(n.toDouble())
        }
        else -> {
            val d = n.toDouble()
            if (d.isFinite() && d == Math.rint(d) && abs(d) <= MAX_SAFE_INTEGER) Cell.Integer(d.toLong()) else Cell.Real(d)
        }
    }
}
