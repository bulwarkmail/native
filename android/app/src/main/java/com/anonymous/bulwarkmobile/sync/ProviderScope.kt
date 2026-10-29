package com.anonymous.bulwarkmobile.sync

import org.json.JSONArray
import org.json.JSONObject

/**
 * Plans provider calls for one account: every selection gets the account
 * condition ANDed in, and every row an operation names by id, or points to
 * from a written column, is checked to belong to the account first
 * (docs/device-sync.md, "Native module API", Scoping).
 *
 * How a table is tied to the account ([TableScope]):
 * - raw contacts, groups, settings, calendars and colors carry it in their
 *   `account_name`/`account_type` columns;
 * - contacts data rows are filtered by ContactsProvider itself through the
 *   `account_name`/`account_type` URI parameters. Their account columns are
 *   never selected on: Android 17 drops them from the Data view for apps
 *   targeting more than API 36;
 * - events get `calendar_id IN (…)` of the account's calendars, not the
 *   account columns: CalendarProvider updates events on the Events table,
 *   which has none;
 * - attendees, reminders and extended properties get `event_id IN (…)` of the
 *   account's events among those the operation touches. CalendarProvider
 *   applies no account filter to them.
 *
 * Selections never use subqueries: the providers may compile them strictly.
 */
class ScopePlanner(private val account: AccountRef, private val lookup: ScopeLookup) {
    private val calendarIds: Set<Long> by lazy { lookup.ownCalendarIds() }

    fun planQuery(query: ProviderQuery): PlannedQuery {
        val target = RowTarget(null, query.where, query.args)
        val selections = if (query.table.scope == TableScope.EVENT_IDS) {
            // Mostly a handful of events (the engine reads children per chunk
            // of events); a query over all of them is split so no selection
            // outgrows a Binder transaction. Rows are then ordered per chunk.
            ownEventsMatching(query.table, target)
                .sorted()
                .chunked(ID_LIST_CHUNK)
                .map { chunk -> selection(query.table, target, chunk) }
        } else {
            listOf(selection(query.table, target, null))
        }
        return PlannedQuery(query.table, query.columns, selections, query.orderBy)
    }

    fun planBatch(ops: List<ProviderOp>): List<PlannedOp> {
        val memberships = membershipUpdates(ops)
        val owners = Owners(ownershipRequests(ops, memberships))
        return ops.mapIndexed { i, op -> plan(i, op, owners, memberships) }
    }

    /**
     * Membership rows among the data rows that updates by id write `data1`
     * of without restating the mimetype: their `data1` names a group, which
     * must be the account's like on insert.
     */
    private fun membershipUpdates(ops: List<ProviderOp>): Set<Long> {
        val ids = ops.asSequence()
            .filterIsInstance<ProviderOp.Update>()
            .filter { it.table == ProviderTable.DATA && writesUntypedData1(it.values) }
            .mapNotNull { it.target.id }
            .toSet()
        if (ids.isEmpty()) return emptySet()
        return lookup.dataMimetypes(ids).filterValues { it == GROUP_MEMBERSHIP_MIMETYPE }.keys
    }

    private fun writesUntypedData1(values: Map<String, Cell>) =
        MIMETYPE !in values && (values[DATA1] ?: Cell.Null) != Cell.Null

    private fun plan(i: Int, op: ProviderOp, owners: Owners, memberships: Set<Long>): PlannedOp = when (op) {
        is ProviderOp.SetSyncState -> PlannedOp.SetSyncState(op.value)
        is ProviderOp.Insert -> {
            checkAccountColumns(i, op.table, op.values)
            checkPhotoFile(i, op.table, op.values)
            checkReferences(i, op.table, op.values - op.refs.keys, owners)
            val values = if (op.table.scope == TableScope.ACCOUNT_COLUMNS) op.values + accountCells() else op.values
            PlannedOp.Insert(op.table, values, op.refs, op.yieldAllowed)
        }
        is ProviderOp.Update -> {
            checkAccountColumns(i, op.table, op.values)
            checkPhotoFile(i, op.table, op.values)
            checkReferences(i, op.table, op.values, owners)
            if (op.table == ProviderTable.DATA && writesUntypedData1(op.values)) {
                checkMembershipUpdate(i, op, owners, memberships)
            }
            checkTarget(i, op.table, op.target, owners)
            if (op.table == ProviderTable.EXTENDED_PROPERTIES) {
                // CalendarProvider updates extended properties only through
                // their item URI, which takes no selection: the id check above
                // is the scope.
                val id = op.target.id
                if (id == null || op.target.where != null) {
                    throw ProviderRefusal(BatchFailure.PROVIDER, "op $i: extended properties can only be updated by id")
                }
                PlannedOp.Update(op.table, Selection.NONE, id, op.values, op.expectCount ?: 1, op.yieldAllowed)
            } else {
                val selection = selection(op.table, op.target, eventScope(op.table, op.target, owners))
                PlannedOp.Update(op.table, selection, null, op.values, expectedCount(op.target, op.expectCount), op.yieldAllowed)
            }
        }
        is ProviderOp.Delete -> {
            checkTarget(i, op.table, op.target, owners)
            val selection = selection(op.table, op.target, eventScope(op.table, op.target, owners))
            PlannedOp.Delete(op.table, selection, expectedCount(op.target, op.expectCount), op.yieldAllowed)
        }
        is ProviderOp.Assert -> {
            checkTarget(i, op.table, op.target, owners)
            val selection = selection(op.table, op.target, eventScope(op.table, op.target, owners))
            val values = op.values?.mapValues { (_, cell) -> cell.text() }
            PlannedOp.Assert(op.table, selection, values, expectedCount(op.target, op.expectCount), op.yieldAllowed)
        }
    }

    /** An op that names one row by id expects exactly that row: the engine relies on it to notice a vanished row. */
    private fun expectedCount(target: RowTarget, expectCount: Int?): Int? =
        expectCount ?: if (target.id != null) 1 else null

    private fun accountCells() = mapOf(
        ACCOUNT_NAME to Cell.Text(account.name),
        ACCOUNT_TYPE to Cell.Text(account.type),
    )

    /**
     * Account columns may only restate the account, on the tables that have
     * them; a data row, event or attendee follows its parent's account.
     */
    private fun checkAccountColumns(i: Int, table: ProviderTable, values: Map<String, Cell>) {
        for (column in listOf(ACCOUNT_NAME, ACCOUNT_TYPE, DATA_SET)) {
            val cell = values[column] ?: continue
            val restatesAccount = table.scope == TableScope.ACCOUNT_COLUMNS && when (column) {
                ACCOUNT_NAME -> cell == Cell.Text(account.name)
                ACCOUNT_TYPE -> cell == Cell.Text(account.type)
                else -> cell == Cell.Null
            }
            if (!restatesAccount) {
                throw ProviderRefusal(BatchFailure.SCOPE, "op $i: ${table.wire}.$column would leave the account")
            }
        }
    }

    /**
     * Parents, masters and groups a written column names must be rows of the
     * account that still exist. (Back-references were checked by the parser:
     * they name inserts of the same batch.)
     */
    private fun checkReferences(i: Int, table: ProviderTable, values: Map<String, Cell>, owners: Owners) {
        for ((column, cell) in values) {
            val referenced = referencedTable(table, column, values) ?: continue
            if (cell == Cell.Null) {
                if (column == table.parentColumn) {
                    throw ProviderRefusal(BatchFailure.SCOPE, "op $i: ${table.wire}.$column must name a ${referenced.wire} row")
                }
                continue
            }
            val id = cell.rowId()
                ?: throw ProviderRefusal(BatchFailure.PROVIDER, "op $i: ${table.wire}.$column must be a row id")
            when (owners.of(referenced, id)) {
                Owner.OURS -> Unit
                Owner.FOREIGN -> throw ProviderRefusal(
                    BatchFailure.SCOPE,
                    "op $i: ${table.wire}.$column names ${referenced.wire} $id of another account",
                )
                // Deleted meanwhile, as far as the engine can tell: re-read and re-plan.
                Owner.MISSING -> throw ProviderRefusal(
                    BatchFailure.ASSERT,
                    "op $i: ${table.wire}.$column names ${referenced.wire} $id, which no longer exists",
                )
            }
        }
    }

    /**
     * `data1` written by an update that doesn't restate the mimetype: on a
     * membership row it names a group. Rows chosen by a selection could be
     * memberships the lookup didn't see, so only updates by id may do it.
     */
    private fun checkMembershipUpdate(i: Int, op: ProviderOp.Update, owners: Owners, memberships: Set<Long>) {
        val id = op.target.id
            ?: throw ProviderRefusal(BatchFailure.SCOPE, "op $i: data1 may only be written to a data row by id")
        if (id !in memberships) return
        val group = op.values[DATA1]?.rowId()
            ?: throw ProviderRefusal(BatchFailure.PROVIDER, "op $i: a membership's data1 must be a group id")
        when (owners.of(ProviderTable.GROUPS, group)) {
            Owner.OURS -> Unit
            Owner.FOREIGN -> throw ProviderRefusal(BatchFailure.SCOPE, "op $i: data.data1 names group $group of another account")
            Owner.MISSING -> throw ProviderRefusal(BatchFailure.ASSERT, "op $i: data.data1 names group $group, which no longer exists")
        }
    }

    /**
     * A photo row's file id (`data14`) is the provider's: it points into the
     * photo store, where another account's file id would let `readPhoto`
     * read that account's photo. Photos are written as bytes (`data15`).
     */
    private fun checkPhotoFile(i: Int, table: ProviderTable, values: Map<String, Cell>) {
        if (table == ProviderTable.DATA && (values[DATA14] ?: Cell.Null) != Cell.Null) {
            throw ProviderRefusal(BatchFailure.SCOPE, "op $i: data.data14 (a photo file id) is written by the provider only")
        }
    }

    /** A row named by id must not belong to another account; a missing one fails on the expected count instead. */
    private fun checkTarget(i: Int, table: ProviderTable, target: RowTarget, owners: Owners) {
        val id = target.id ?: return
        if (owners.of(table, id) == Owner.FOREIGN) {
            throw ProviderRefusal(BatchFailure.SCOPE, "op $i: ${table.wire} $id belongs to another account")
        }
    }

    /** For attendees, reminders and extended properties: the account's events the op may touch. */
    private fun eventScope(table: ProviderTable, target: RowTarget, owners: Owners): Collection<Long>? {
        if (table.scope != TableScope.EVENT_IDS) return null
        val id = target.id ?: return ownEventsMatching(table, target)
        return listOfNotNull(owners.eventOf(table, id))
    }

    private fun ownEventsMatching(table: ProviderTable, target: RowTarget): Set<Long> {
        val candidates = lookup.childEventIdsMatching(table, target.where, target.args)
        if (candidates.isEmpty()) return emptySet()
        return lookup.eventCalendars(candidates).filterValues { it in calendarIds }.keys
    }

    private fun selection(table: ProviderTable, target: RowTarget, eventIds: Collection<Long>?): Selection {
        val parts = ArrayList<String>(3)
        val args = ArrayList<String>()
        target.id?.let {
            parts += "${table.idColumn} = ?"
            args += it.toString()
        }
        target.where?.let {
            parts += it
            args += target.args
        }
        when (table.scope) {
            TableScope.ACCOUNT_COLUMNS -> {
                parts += "$ACCOUNT_NAME = ? AND $ACCOUNT_TYPE = ?"
                args += account.name
                args += account.type
            }
            TableScope.URI_PARAMETERS -> Unit
            TableScope.CALENDAR_IDS -> parts += idList("calendar_id", calendarIds)
            TableScope.EVENT_IDS -> parts += idList("event_id", eventIds.orEmpty())
        }
        return Selection(parts.takeIf { it.isNotEmpty() }?.joinToString(" AND ") { "($it)" }, args)
    }

    /** Every row id the batch names, by table: op targets and referenced rows. */
    private fun ownershipRequests(ops: List<ProviderOp>, memberships: Set<Long>): Map<ProviderTable, Set<Long>> {
        val requests = HashMap<ProviderTable, MutableSet<Long>>()
        fun request(table: ProviderTable, id: Long) {
            requests.getOrPut(table) { HashSet() } += id
        }
        fun requestReferences(table: ProviderTable, values: Map<String, Cell>) {
            for ((column, cell) in values) {
                val referenced = referencedTable(table, column, values) ?: continue
                cell.rowId()?.let { request(referenced, it) }
            }
        }
        for (op in ops) {
            when (op) {
                is ProviderOp.Insert -> requestReferences(op.table, op.values)
                is ProviderOp.Update -> {
                    requestReferences(op.table, op.values)
                    op.target.id?.let { request(op.table, it) }
                    if (op.target.id in memberships) op.values[DATA1]?.rowId()?.let { request(ProviderTable.GROUPS, it) }
                }
                is ProviderOp.Delete -> op.target.id?.let { request(op.table, it) }
                is ProviderOp.Assert -> op.target.id?.let { request(op.table, it) }
                is ProviderOp.SetSyncState -> Unit
            }
        }
        return requests
    }

    private enum class Owner { OURS, FOREIGN, MISSING }

    /** Who owns the rows a batch names, resolved up front with as few lookups as the tables allow. */
    private inner class Owners(requests: Map<ProviderTable, Set<Long>>) {
        private val owners = HashMap<ProviderTable, Map<Long, Owner>>()
        private val childEvents = HashMap<ProviderTable, Map<Long, Long>>()

        init {
            // Children lead to events, data rows to raw contacts; both are
            // added to their parent's lookup.
            val eventIds = HashSet(requests[ProviderTable.EVENTS].orEmpty())
            for (table in CHILD_TABLES) {
                val ids = requests[table] ?: continue
                val events = lookup.childEvents(table, ids)
                childEvents[table] = events
                eventIds += events.values
            }
            val rawContactIds = HashSet(requests[ProviderTable.RAW_CONTACTS].orEmpty())
            val dataParents = requests[ProviderTable.DATA]?.let { lookup.dataRawContacts(it) }.orEmpty()
            rawContactIds += dataParents.values

            if (eventIds.isNotEmpty()) {
                owners[ProviderTable.EVENTS] = lookup.eventCalendars(eventIds)
                    .mapValues { (_, calendarId) -> if (calendarId in calendarIds) Owner.OURS else Owner.FOREIGN }
            }
            for ((table, events) in childEvents) {
                // A child whose event is gone is an orphan, not ours.
                owners[table] = events.mapValues { (_, eventId) -> ownerOrForeign(ProviderTable.EVENTS, eventId) }
            }
            val roots = HashMap<ProviderTable, Set<Long>>()
            for (table in ROOT_TABLES) requests[table]?.let { roots[table] = it }
            if (rawContactIds.isNotEmpty()) roots[ProviderTable.RAW_CONTACTS] = rawContactIds
            for ((table, ids) in roots) {
                owners[table] = lookup.rootAccounts(table, ids)
                    .mapValues { (_, owner) -> if (owner == account) Owner.OURS else Owner.FOREIGN }
            }
            if (dataParents.isNotEmpty()) {
                owners[ProviderTable.DATA] = dataParents.mapValues { (_, rawContactId) ->
                    ownerOrForeign(ProviderTable.RAW_CONTACTS, rawContactId)
                }
            }
        }

        private fun ownerOrForeign(table: ProviderTable, id: Long): Owner =
            owners[table]?.get(id)?.takeIf { it != Owner.MISSING } ?: Owner.FOREIGN

        fun of(table: ProviderTable, id: Long): Owner = owners[table]?.get(id) ?: Owner.MISSING

        /** The event of a child row, when both exist and are the account's. */
        fun eventOf(table: ProviderTable, id: Long): Long? =
            childEvents[table]?.get(id)?.takeIf { of(table, id) == Owner.OURS }
    }

    companion object {
        const val ACCOUNT_NAME = "account_name"
        const val ACCOUNT_TYPE = "account_type"
        const val DATA_SET = "data_set"
        private const val MIMETYPE = "mimetype"
        private const val DATA1 = "data1"
        private const val DATA14 = "data14"

        /** Ids per `IN (…)` list: a few KB of selection, far from SQLite's and Binder's limits. */
        const val ID_LIST_CHUNK = 500

        private val CHILD_TABLES = ProviderTable.entries.filter { it.scope == TableScope.EVENT_IDS }
        private val ROOT_TABLES = ProviderTable.entries.filter { it.scope == TableScope.ACCOUNT_COLUMNS }

        /** `column IN (1,2,3)`, or a condition no row meets. The ids are ours to inline: numbers we read. */
        fun idList(column: String, ids: Collection<Long>): String =
            if (ids.isEmpty()) "0" else ids.sorted().joinToString(",", "$column IN (", ")")
    }
}

/** An Android account of our type: the scope of every provider call. */
data class AccountRef(val name: String, val type: String)

/**
 * What [ScopePlanner] needs to know about rows beyond the operations
 * themselves. [ProviderIo] answers with provider queries: except for
 * [ownCalendarIds], these read rows of any account, but only their ids and
 * owners, to tell rows of another account from rows that are gone.
 */
interface ScopeLookup {
    /** `_id`s of the account's calendars. */
    fun ownCalendarIds(): Set<Long>

    /** The account of each row of a root table that exists. */
    fun rootAccounts(table: ProviderTable, ids: Set<Long>): Map<Long, AccountRef>

    /** The raw contact of each data row that exists. */
    fun dataRawContacts(ids: Set<Long>): Map<Long, Long>

    /** The mimetype of each data row that exists. */
    fun dataMimetypes(ids: Set<Long>): Map<Long, String>

    /** The calendar of each event that exists. */
    fun eventCalendars(ids: Set<Long>): Map<Long, Long>

    /** The event of each attendee, reminder or extended property that exists. */
    fun childEvents(table: ProviderTable, ids: Set<Long>): Map<Long, Long>

    /** The events of the rows of a child table that match [where]. */
    fun childEventIdsMatching(table: ProviderTable, where: String?, args: List<String>): Set<Long>
}

/** A selection with its `?` arguments; a null [sql] selects every row the URI allows. */
data class Selection(val sql: String?, val args: List<String>) {
    companion object {
        val NONE = Selection(null, emptyList())
    }
}

/** A provider query, split into [selections] when its scope list is long; no selection means no rows. */
data class PlannedQuery(
    val table: ProviderTable,
    val columns: List<String>,
    val selections: List<Selection>,
    val orderBy: String?,
)

/** One ContentProviderOperation, ready to build on the account's sync-adapter URI. */
sealed interface PlannedOp {
    val yieldAllowed: Boolean

    data class Insert(
        val table: ProviderTable,
        val values: Map<String, Cell>,
        val backReferences: Map<String, Int>,
        override val yieldAllowed: Boolean,
    ) : PlannedOp

    /** [itemId] set: an update through the row's own URI, without a selection. */
    data class Update(
        val table: ProviderTable,
        val selection: Selection,
        val itemId: Long?,
        val values: Map<String, Cell>,
        val expectedCount: Int?,
        override val yieldAllowed: Boolean,
    ) : PlannedOp

    data class Delete(
        val table: ProviderTable,
        val selection: Selection,
        val expectedCount: Int?,
        override val yieldAllowed: Boolean,
    ) : PlannedOp

    /** [values] compared as text, as ContentProviderOperation does. */
    data class Assert(
        val table: ProviderTable,
        val selection: Selection,
        val values: Map<String, String?>?,
        val expectedCount: Int?,
        override val yieldAllowed: Boolean,
    ) : PlannedOp

    data class SetSyncState(val value: String) : PlannedOp {
        override val yieldAllowed: Boolean get() = false
    }
}

/** The result of one op, as `OpResult` of types.ts. */
data class OpOutcome(val id: Long? = null, val count: Int? = null)

object ProviderResults {
    fun ok(results: List<OpOutcome>): String {
        val array = JSONArray()
        for (result in results) {
            array.put(JSONObject().apply {
                result.id?.let { put("id", it) }
                result.count?.let { put("count", it) }
            })
        }
        return JSONObject().put("ok", true).put("results", array).toString()
    }

    fun failed(reason: BatchFailure, message: String?): String = JSONObject()
        .put("ok", false)
        .put("reason", reason.wire)
        .put("message", message ?: reason.wire)
        .toString()

    /**
     * An OperationApplicationException is an assert that did not hold or an
     * expected count that did not match (`assert`), except when an insert got
     * no row back or ContactsProvider refused the batch's yield points.
     */
    fun failureOfOperationApplication(message: String?): BatchFailure = when {
        message == null -> BatchFailure.ASSERT
        message.startsWith("Insert into ") -> BatchFailure.PROVIDER
        message.startsWith("Too many content provider operations") -> BatchFailure.PROVIDER
        else -> BatchFailure.ASSERT
    }
}

/**
 * Query results as `ProviderRows` JSON, built by hand: a chunk of contacts
 * can carry megabytes of shadows, and this is the hot path of every run.
 */
class ProviderRowsWriter(columns: List<String>) {
    private val out = StringBuilder(4096)
    private var rows = 0
    private var cells = 0

    init {
        out.append("{\"columns\":[")
        columns.forEachIndexed { i, column ->
            if (i > 0) out.append(',')
            appendString(column)
        }
        out.append("],\"rows\":[")
    }

    fun beginRow() {
        if (rows++ > 0) out.append(',')
        out.append('[')
        cells = 0
    }

    fun endRow() {
        out.append(']')
    }

    fun nullCell() = cell { out.append("null") }

    fun longCell(value: Long) = cell { out.append(value) }

    fun doubleCell(value: Double) = cell { if (value.isFinite()) out.append(value) else out.append("null") }

    fun textCell(value: String) = cell { appendString(value) }

    fun finish(): String = out.append("]}").toString()

    private inline fun cell(write: () -> Unit) {
        if (cells++ > 0) out.append(',')
        write()
    }

    private fun appendString(s: String) {
        out.append('"')
        for (c in s) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' || c.code == 0x2028 || c.code == 0x2029 ->
                    out.append("\\u").append(Integer.toHexString(c.code).padStart(4, '0'))
                else -> out.append(c)
            }
        }
        out.append('"')
    }
}

/** Sizes for [ProviderIo.readPhoto]: decode close to the target, then scale the longer side down to it. */
object PhotoScaling {
    /** The largest power of two that keeps the decoded image at least [maxPx] on its longer side. */
    fun sampleSize(width: Int, height: Int, maxPx: Int): Int {
        require(maxPx > 0) { "maxPx must be positive" }
        var sample = 1
        val longer = maxOf(width, height)
        while (longer / (sample * 2) >= maxPx) sample *= 2
        return sample
    }

    fun targetSize(width: Int, height: Int, maxPx: Int): Pair<Int, Int> {
        val longer = maxOf(width, height)
        if (longer <= maxPx) return width to height
        val scale = maxPx.toDouble() / longer
        return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
    }
}
