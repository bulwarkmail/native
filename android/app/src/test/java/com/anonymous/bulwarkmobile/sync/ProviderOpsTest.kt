package com.anonymous.bulwarkmobile.sync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigDecimal
import java.math.BigInteger

private const val CONTACTS = "com.android.contacts"
private const val CALENDAR = "com.android.calendar"
private val ME = AccountRef("alice@example.org", "com.anonymous.bulwarkmobile.account")
private val OTHER = AccountRef("bob@gmail.com", "com.google")

/** The provider as far as the planner asks: who owns which row; [me] is the account the lookup is bound to. */
private class FakeLookup(private val me: AccountRef = ME) : ScopeLookup {
    val rawContacts = HashMap<Long, AccountRef>()
    val groups = HashMap<Long, AccountRef>()
    val calendars = HashMap<Long, AccountRef>()
    val colors = HashMap<Long, AccountRef>()
    /** data id → raw contact */
    val data = HashMap<Long, Long>()
    /** data id → mimetype */
    val mimetypes = HashMap<Long, String>()
    /** event id → calendar */
    val events = HashMap<Long, Long>()
    /** child table → child id → event */
    val children = HashMap<ProviderTable, HashMap<Long, Long>>()
    /** (child table, where) → events of the matching rows; a null where matches every row. */
    val matching = HashMap<Pair<ProviderTable, String?>, Set<Long>>()

    override fun ownCalendarIds() = calendars.filterValues { it == me }.keys

    override fun rootAccounts(table: ProviderTable, ids: Set<Long>): Map<Long, AccountRef> = when (table) {
        ProviderTable.RAW_CONTACTS -> rawContacts
        ProviderTable.GROUPS -> groups
        ProviderTable.CALENDARS -> calendars
        ProviderTable.COLORS -> colors
        else -> throw AssertionError("no root lookup for $table")
    }.filterKeys { it in ids }

    override fun dataRawContacts(ids: Set<Long>) = data.filterKeys { it in ids }

    override fun dataMimetypes(ids: Set<Long>) = mimetypes.filterKeys { it in ids }

    override fun eventCalendars(ids: Set<Long>) = events.filterKeys { it in ids }

    override fun childEvents(table: ProviderTable, ids: Set<Long>): Map<Long, Long> =
        children[table].orEmpty().filterKeys { it in ids }

    override fun childEventIdsMatching(table: ProviderTable, where: String?, args: List<String>): Set<Long> =
        matching[table to where] ?: if (where == null) children[table].orEmpty().values.toSet() else emptySet()

    fun child(table: ProviderTable, id: Long, event: Long) {
        children.getOrPut(table) { HashMap() }[id] = event
    }
}

class ProviderOpsTest {
    private val lookup = FakeLookup().apply {
        rawContacts[1] = ME
        rawContacts[2] = OTHER
        groups[10] = ME
        groups[11] = OTHER
        data[100] = 1
        data[101] = 2
        calendars[20] = ME
        calendars[21] = ME
        calendars[22] = OTHER
        colors[40] = ME
        events[30] = 20
        events[31] = 21
        events[32] = 22
        child(ProviderTable.ATTENDEES, 50, 30)
        child(ProviderTable.ATTENDEES, 51, 32)
        child(ProviderTable.REMINDERS, 60, 31)
        child(ProviderTable.EXTENDED_PROPERTIES, 70, 30)
        child(ProviderTable.EXTENDED_PROPERTIES, 71, 32)
    }
    private val planner = ScopePlanner(ME, lookup)

    private fun ops(vararg op: String) = "[${op.joinToString(",")}]"

    private fun plan(authority: String, vararg op: String) =
        planner.planBatch(ProviderOpParser.parseBatch(authority, ops(*op)))

    private fun refused(reason: BatchFailure, block: () -> Unit): String {
        try {
            block()
        } catch (e: ProviderRefusal) {
            assertEquals(e.message, reason, e.reason)
            return e.message.orEmpty()
        }
        fail("expected a $reason refusal")
        throw AssertionError()
    }

    // ── tables and parsing ──────────────────────────────────────

    @Test
    fun `tables are enumerated per authority and anything else is out of scope`() {
        assertEquals(ProviderTable.EXTENDED_PROPERTIES, ProviderTable.of(CALENDAR, "extended_properties"))
        assertEquals(ProviderTable.SETTINGS, ProviderTable.of(CONTACTS, "settings"))
        refused(BatchFailure.SCOPE) { ProviderTable.of(CONTACTS, "events") }
        refused(BatchFailure.SCOPE) { ProviderTable.of(CALENDAR, "raw_contacts") }
        refused(BatchFailure.SCOPE) { ProviderTable.of(CONTACTS, "contacts") }
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"delete","table":"instances","where":"1"}""") }
    }

    @Test
    fun `numbers keep integers exact whatever org_json parsed them into`() {
        assertEquals(Cell.Integer(5), ProviderOpParser.numberCell(5))
        assertEquals(Cell.Integer(5), ProviderOpParser.numberCell(5.0))
        assertEquals(Cell.Integer(5), ProviderOpParser.numberCell(BigDecimal("5.0")))
        assertEquals(Cell.Integer(1L shl 60), ProviderOpParser.numberCell(BigInteger.ONE.shiftLeft(60)))
        assertEquals(Cell.Integer(1_700_000_000_000), ProviderOpParser.numberCell(1_700_000_000_000L))
        assertEquals(Cell.Real(1.5), ProviderOpParser.numberCell(BigDecimal("1.5")))
        assertEquals(Cell.Real(1.5), ProviderOpParser.numberCell(1.5))
    }

    @Test
    fun `values keep text, numbers, booleans as 0 and 1, and nulls`() {
        val insert = ProviderOpParser.parseBatch(
            CONTACTS,
            ops("""{"op":"insert","table":"raw_contacts","values":{"sync1":"a","dirty":0,"starred":true,"sync2":null}}"""),
        ).single() as ProviderOp.Insert
        assertEquals(
            mapOf("sync1" to Cell.Text("a"), "dirty" to Cell.Integer(0), "starred" to Cell.Integer(1), "sync2" to Cell.Null),
            insert.values,
        )
    }

    @Test
    fun `malformed ops are provider failures`() {
        refused(BatchFailure.PROVIDER) { ProviderOpParser.parseBatch(CONTACTS, "{}") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"upsert","table":"groups","values":{}}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"update","table":"groups","id":10,"values":{}}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"assert","table":"groups","where":"dirty = 1"}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"delete","table":"settings","id":1}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"delete","table":"groups","args":["x"]}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"delete","table":"groups","id":1.5}""") }
        refused(BatchFailure.PROVIDER) { plan(CONTACTS, """{"op":"delete","table":"groups","where":"a = ?","args":[null]}""") }
    }

    @Test
    fun `bytes are only accepted for data_data15`() {
        val planned = plan(
            CONTACTS,
            """{"op":"insert","table":"data","values":{"raw_contact_id":1,"mimetype":"vnd.android.cursor.item/photo","data15":{"b64":"AAEC"}}}""",
        ).single() as PlannedOp.Insert
        assertEquals(Cell.Blob("AAEC"), planned.values["data15"])
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"update","table":"raw_contacts","id":1,"values":{"sync2":{"b64":"AAEC"}}}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,"data1":{"b64":"AA"}}}""")
        }
        refused(BatchFailure.PROVIDER) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,"data15":{"bytes":"AA"}}}""")
        }
    }

    // ── batch rules ─────────────────────────────────────────────

    @Test
    fun `a syncState op must be the last op and not a yield point`() {
        val planned = plan(
            CONTACTS,
            """{"op":"update","table":"groups","id":10,"values":{"sync2":"x"},"yieldAllowed":true}""",
            """{"op":"syncState","value":"{\"v\":1}"}""",
        )
        assertEquals(PlannedOp.SetSyncState("{\"v\":1}"), planned.last())
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"syncState","value":"{}"}""", """{"op":"delete","table":"groups","id":10}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(
                CONTACTS,
                """{"op":"delete","table":"groups","id":10}""",
                """{"op":"syncState","value":"{}","yieldAllowed":true}""",
            )
        }
    }

    private fun deletes(count: Int, yieldAt: Set<Int> = emptySet()) = (0 until count).joinToString(",", "[", "]") { i ->
        """{"op":"delete","table":"groups","where":"sync1 = ?","args":["$i"]${if (i in yieldAt) ""","yieldAllowed":true""" else ""}}"""
    }

    @Test
    fun `contacts batches stop at 499 ops between yield points, counted as ContactsProvider does`() {
        assertEquals(499, ProviderOpParser.parseBatch(CONTACTS, deletes(499)).size)
        refused(BatchFailure.PROVIDER) { ProviderOpParser.parseBatch(CONTACTS, deletes(500)) }
        // The yielding op still counts toward the ops before it.
        assertEquals(998, ProviderOpParser.parseBatch(CONTACTS, deletes(998, setOf(498))).size)
        refused(BatchFailure.PROVIDER) { ProviderOpParser.parseBatch(CONTACTS, deletes(999, setOf(498))) }
        refused(BatchFailure.PROVIDER) { ProviderOpParser.parseBatch(CONTACTS, deletes(600, setOf(499))) }
        // A yield on the first op is ignored, as the provider ignores it.
        refused(BatchFailure.PROVIDER) { ProviderOpParser.parseBatch(CONTACTS, deletes(500, setOf(0))) }
    }

    @Test
    fun `calendar batches have no yield point limit`() {
        val many = (0 until 600).joinToString(",", "[", "]") { """{"op":"delete","table":"colors","where":"color_index = '$it'"}""" }
        assertEquals(600, ProviderOpParser.parseBatch(CALENDAR, many).size)
    }

    @Test
    fun `back-references name earlier inserts, and parents name their parent table`() {
        val planned = plan(
            CONTACTS,
            """{"op":"insert","table":"raw_contacts","values":{"sourceid":"c/1"}}""",
            """{"op":"insert","table":"data","values":{"mimetype":"vnd.android.cursor.item/name","data1":"A"},"refs":{"raw_contact_id":0}}""",
        )
        assertEquals(mapOf("raw_contact_id" to 0), (planned[1] as PlannedOp.Insert).backReferences)
        refused(BatchFailure.PROVIDER) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"mimetype":"x"},"refs":{"raw_contact_id":0}}""")
        }
        refused(BatchFailure.PROVIDER) {
            plan(
                CONTACTS,
                """{"op":"delete","table":"groups","id":10}""",
                """{"op":"insert","table":"data","values":{"mimetype":"x"},"refs":{"raw_contact_id":0}}""",
            )
        }
        // Settings rows have no id to refer to.
        refused(BatchFailure.PROVIDER) {
            plan(
                CONTACTS,
                """{"op":"insert","table":"settings","values":{"ungrouped_visible":1}}""",
                """{"op":"insert","table":"data","values":{"mimetype":"x"},"refs":{"raw_contact_id":0}}""",
            )
        }
        refused(BatchFailure.SCOPE) {
            plan(
                CONTACTS,
                """{"op":"insert","table":"groups","values":{"title":"g"}}""",
                """{"op":"insert","table":"data","values":{"mimetype":"x"},"refs":{"raw_contact_id":0}}""",
            )
        }
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"insert","table":"data","values":{"mimetype":"x"}}""") }
        refused(BatchFailure.SCOPE) {
            plan(CALENDAR, """{"op":"insert","table":"attendees","values":{"event_id":null,"attendeeEmail":"a@b"}}""")
        }
    }

    // ── scope: inserts ──────────────────────────────────────────

    @Test
    fun `root inserts are written into the account, whatever the op says`() {
        val planned = plan(
            CONTACTS,
            """{"op":"insert","table":"raw_contacts","values":{"sourceid":"c/1","account_name":"alice@example.org"}}""",
        ).single() as PlannedOp.Insert
        assertEquals(Cell.Text(ME.name), planned.values["account_name"])
        assertEquals(Cell.Text(ME.type), planned.values["account_type"])
        val calendar = plan(CALENDAR, """{"op":"insert","table":"calendars","values":{"name":"c"}}""").single()
        assertEquals(Cell.Text(ME.type), (calendar as PlannedOp.Insert).values["account_type"])
    }

    @Test
    fun `account columns never move a row out of the account`() {
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"insert","table":"raw_contacts","values":{"account_name":"bob@gmail.com"}}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"update","table":"groups","id":10,"values":{"account_type":"com.google"}}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"insert","table":"groups","values":{"title":"g","data_set":"plugin"}}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,"account_name":"alice@example.org"}}""")
        }
        refused(BatchFailure.SCOPE) {
            plan(CALENDAR, """{"op":"update","table":"events","id":30,"values":{"account_name":"alice@example.org"}}""")
        }
    }

    @Test
    fun `inserts must name a parent of the account that still exists`() {
        plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,"mimetype":"x"}}""")
        plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":"1","mimetype":"x"}}""")
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":2,"mimetype":"x"}}""") }
        refused(BatchFailure.ASSERT) { plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":9,"mimetype":"x"}}""") }
        refused(BatchFailure.PROVIDER) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":"me","mimetype":"x"}}""")
        }
        plan(CALENDAR, """{"op":"insert","table":"events","values":{"calendar_id":21,"dtstart":0}}""")
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"insert","table":"events","values":{"calendar_id":22,"dtstart":0}}""") }
        refused(BatchFailure.SCOPE) {
            plan(CALENDAR, """{"op":"insert","table":"events","values":{"calendar_id":20,"original_id":32}}""")
        }
        plan(CALENDAR, """{"op":"insert","table":"reminders","values":{"event_id":31,"minutes":10}}""")
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"insert","table":"reminders","values":{"event_id":32,"minutes":10}}""") }
        refused(BatchFailure.ASSERT) { plan(CALENDAR, """{"op":"insert","table":"attendees","values":{"event_id":99}}""") }
    }

    @Test
    fun `a membership row may only name a group of the account`() {
        val membership = """"mimetype":"vnd.android.cursor.item/group_membership""""
        plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,$membership,"data1":10}}""")
        plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,$membership,"group_sourceid":"c/g"}}""")
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,$membership,"data1":11}}""")
        }
        // data1 of other kinds is plain data.
        plan(CONTACTS, """{"op":"insert","table":"data","values":{"raw_contact_id":1,"mimetype":"x","data1":11}}""")
    }

    @Test
    fun `a membership row's group is checked on updates by id too`() {
        lookup.mimetypes[100] = GROUP_MEMBERSHIP_MIMETYPE
        plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data1":10}}""")
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data1":11}}""") }
        refused(BatchFailure.ASSERT) { plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data1":12}}""") }
        // data1 by a selection could reach memberships the lookup never saw.
        refused(BatchFailure.SCOPE) {
            plan(CONTACTS, """{"op":"update","table":"data","where":"raw_contact_id = ?","args":[1],"values":{"data1":11}}""")
        }
        // data1 of other kinds is plain data.
        lookup.mimetypes[100] = "vnd.android.cursor.item/phone_v2"
        plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data1":11}}""")
    }

    @Test
    fun `photo file ids are never written`() {
        val photo = """"raw_contact_id":1,"mimetype":"vnd.android.cursor.item/photo""""
        plan(CONTACTS, """{"op":"insert","table":"data","values":{$photo,"data14":null,"data15":{"b64":"AAAA"}}}""")
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"insert","table":"data","values":{$photo,"data14":5}}""") }
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data14":5}}""") }
    }

    @Test
    fun `a selection can't close the scope's parentheses or query elsewhere`() {
        for (where in listOf("1) OR (1", "dirty = 1) OR (1 = 1", "(1", "1; DELETE FROM events", "1 -- x", "1 /* x */",
            "_id IN (SELECT _id FROM events)", "1 UNION ALL x", "title = 'open")) {
            val quoted = JSONObject.quote(where)
            refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"update","table":"events","where":$quoted,"values":{"dirty":1}}""") }
            refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"delete","table":"attendees","where":$quoted}""") }
            refused(BatchFailure.SCOPE) {
                ProviderOpParser.parseQuery(CALENDAR, """{"table":"attendees","columns":["_id"],"where":$quoted}""")
            }
        }
        refused(BatchFailure.SCOPE) {
            ProviderOpParser.parseQuery(CONTACTS, """{"table":"raw_contacts","columns":["_id"],"orderBy":"_id); DROP TABLE x; --"}""")
        }
        // Parentheses and keywords inside quoted literals are data.
        plan(CALENDAR, """{"op":"update","table":"events","where":"title = '(x' OR title = 'select'","values":{"dirty":1}}""")
        plan(CALENDAR, """{"op":"assert","table":"events","where":"(dirty = 1 OR deleted = 1) AND _sync_id LIKE '~pending/%'","expectCount":0}""")
        ProviderOpParser.parseQuery(CONTACTS, """{"table":"raw_contacts","columns":["_id"],"orderBy":"_id DESC"}""")
    }

    @Test
    fun `moving a row to another parent is checked like an insert`() {
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"update","table":"events","id":30,"values":{"calendar_id":22}}""") }
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"raw_contact_id":null}}""") }
        plan(CALENDAR, """{"op":"update","table":"events","id":30,"values":{"calendar_id":21}}""")
    }

    // ── scope: selections ───────────────────────────────────────

    @Test
    fun `root tables are selected by their account columns`() {
        val op = plan(
            CONTACTS,
            """{"op":"update","table":"raw_contacts","where":"dirty = ? AND deleted = 0","args":[1],"values":{"dirty":0}}""",
        ).single() as PlannedOp.Update
        assertEquals(
            Selection("(dirty = ? AND deleted = 0) AND (account_name = ? AND account_type = ?)", listOf("1", ME.name, ME.type)),
            op.selection,
        )
        assertNull(op.expectedCount)
    }

    @Test
    fun `an op by id selects that row of the account and expects exactly one row`() {
        val op = plan(CONTACTS, """{"op":"delete","table":"groups","id":10}""").single() as PlannedOp.Delete
        assertEquals(Selection("(_id = ?) AND (account_name = ? AND account_type = ?)", listOf("10", ME.name, ME.type)), op.selection)
        assertEquals(1, op.expectedCount)
        val counted = plan(CONTACTS, """{"op":"assert","table":"raw_contacts","id":1,"expectCount":0}""").single()
        assertEquals(0, (counted as PlannedOp.Assert).expectedCount)
    }

    @Test
    fun `an id of another account is refused, a vanished one is left to the expected count`() {
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"delete","table":"raw_contacts","id":2}""") }
        refused(BatchFailure.SCOPE) { plan(CONTACTS, """{"op":"update","table":"data","id":101,"values":{"data1":"x"}}""") }
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"assert","table":"events","id":32,"values":{"dirty":0}}""") }
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"delete","table":"attendees","id":51}""") }
        refused(BatchFailure.SCOPE) { plan(CALENDAR, """{"op":"update","table":"calendars","id":22,"values":{"name":"x"}}""") }
        val gone = plan(CONTACTS, """{"op":"delete","table":"raw_contacts","id":9}""").single() as PlannedOp.Delete
        assertEquals(1, gone.expectedCount)
    }

    @Test
    fun `data rows rely on the URI parameters and never select on the Data view's account columns`() {
        val op = plan(CONTACTS, """{"op":"update","table":"data","id":100,"values":{"data1":"x"}}""").single() as PlannedOp.Update
        assertEquals(Selection("(_id = ?)", listOf("100")), op.selection)
        val query = planner.planQuery(ProviderOpParser.parseQuery(CONTACTS, """{"table":"data","columns":["_id"],"where":"raw_contact_id IN (1)"}"""))
        assertEquals(listOf(Selection("(raw_contact_id IN (1))", emptyList())), query.selections)
        val all = planner.planQuery(ProviderOpParser.parseQuery(CONTACTS, """{"table":"data","columns":["_id"]}"""))
        assertEquals(listOf(Selection.NONE), all.selections)
    }

    @Test
    fun `events are selected by the account's calendars`() {
        val query = planner.planQuery(
            ProviderOpParser.parseQuery(CALENDAR, """{"table":"events","columns":["_id","title"],"where":"dirty = 1","orderBy":"_id"}"""),
        )
        assertEquals(listOf(Selection("(dirty = 1) AND (calendar_id IN (20,21))", emptyList())), query.selections)
        assertEquals("_id", query.orderBy)
        val update = plan(CALENDAR, """{"op":"update","table":"events","id":30,"values":{"dirty":0}}""").single() as PlannedOp.Update
        assertEquals(Selection("(_id = ?) AND (calendar_id IN (20,21))", listOf("30")), update.selection)
    }

    @Test
    fun `an account without calendars selects no events`() {
        val carol = AccountRef("carol", ME.type)
        val empty = ScopePlanner(carol, FakeLookup(carol).apply { calendars.putAll(lookup.calendars) })
        val query = empty.planQuery(ProviderOpParser.parseQuery(CALENDAR, """{"table":"events","columns":["_id"]}"""))
        assertEquals(listOf(Selection("(0)", emptyList())), query.selections)
    }

    @Test
    fun `children of events are selected by the account's events among those they touch`() {
        lookup.matching[ProviderTable.ATTENDEES to "event_id IN (30,32)"] = setOf(30, 32)
        val query = planner.planQuery(
            ProviderOpParser.parseQuery(CALENDAR, """{"table":"attendees","columns":["attendeeEmail"],"where":"event_id IN (30,32)"}"""),
        )
        assertEquals(listOf(Selection("(event_id IN (30,32)) AND (event_id IN (30))", emptyList())), query.selections)

        val byId = plan(CALENDAR, """{"op":"delete","table":"attendees","id":50}""").single() as PlannedOp.Delete
        assertEquals(Selection("(Attendees._id = ?) AND (event_id IN (30))", listOf("50")), byId.selection)
        assertEquals(1, byId.expectedCount)

        val gone = plan(CALENDAR, """{"op":"delete","table":"reminders","id":69}""").single() as PlannedOp.Delete
        assertEquals(Selection("(Reminders._id = ?) AND (0)", listOf("69")), gone.selection)

        lookup.matching[ProviderTable.REMINDERS to "event_id = ?"] = setOf(31)
        val byWhere = plan(CALENDAR, """{"op":"delete","table":"reminders","where":"event_id = ?","args":[31]}""").single()
        assertEquals(Selection("(event_id = ?) AND (event_id IN (31))", listOf("31")), (byWhere as PlannedOp.Delete).selection)
    }

    @Test
    fun `a child query that touches none of the account's events reads nothing`() {
        lookup.matching[ProviderTable.ATTENDEES to "event_id = 32"] = setOf(32)
        val query = planner.planQuery(
            ProviderOpParser.parseQuery(CALENDAR, """{"table":"attendees","columns":["_id"],"where":"event_id = 32"}"""),
        )
        assertTrue(query.selections.isEmpty())
    }

    @Test
    fun `long event lists are split into chunks`() {
        val many = (1000L until 1000L + 1200).toSet()
        for (id in many) lookup.events[id] = 20
        lookup.matching[ProviderTable.REMINDERS to null] = many
        val query = planner.planQuery(ProviderOpParser.parseQuery(CALENDAR, """{"table":"reminders","columns":["minutes"]}"""))
        assertEquals(3, query.selections.size)
        assertTrue(query.selections.all { it.sql!!.startsWith("(event_id IN (") })
    }

    @Test
    fun `extended properties are updated through their item URI, so only by id`() {
        val op = plan(CALENDAR, """{"op":"update","table":"extended_properties","id":70,"values":{"value":"v"}}""").single()
        assertEquals(PlannedOp.Update(ProviderTable.EXTENDED_PROPERTIES, Selection.NONE, 70, mapOf("value" to Cell.Text("v")), 1, false), op)
        refused(BatchFailure.SCOPE) {
            plan(CALENDAR, """{"op":"update","table":"extended_properties","id":71,"values":{"value":"v"}}""")
        }
        refused(BatchFailure.PROVIDER) {
            plan(CALENDAR, """{"op":"update","table":"extended_properties","where":"name = 'x'","values":{"value":"v"}}""")
        }
    }

    @Test
    fun `asserts compare text and keep nulls`() {
        val op = plan(
            CONTACTS,
            """{"op":"assert","table":"raw_contacts","id":1,"values":{"version":3,"dirty":0,"sync3":null,"sourceid":"c/1"}}""",
        ).single() as PlannedOp.Assert
        assertEquals(mapOf("version" to "3", "dirty" to "0", "sync3" to null, "sourceid" to "c/1"), op.values)
        assertEquals(1, op.expectedCount)
    }

    @Test
    fun `settings are written by account`() {
        val insert = plan(CONTACTS, """{"op":"insert","table":"settings","values":{"ungrouped_visible":1,"should_sync":1}}""").single()
        assertEquals(Cell.Text(ME.name), (insert as PlannedOp.Insert).values["account_name"])
        val update = plan(CONTACTS, """{"op":"update","table":"settings","values":{"ungrouped_visible":1}}""").single()
        assertEquals(
            Selection("(account_name = ? AND account_type = ?)", listOf(ME.name, ME.type)),
            (update as PlannedOp.Update).selection,
        )
    }

    // ── results ─────────────────────────────────────────────────

    @Test
    fun `batch results are BatchResult JSON`() {
        val ok = JSONObject(ProviderResults.ok(listOf(OpOutcome(id = 7), OpOutcome(count = 1), OpOutcome())))
        assertEquals(true, ok.getBoolean("ok"))
        val results = ok.getJSONArray("results")
        assertEquals(7L, results.getJSONObject(0).getLong("id"))
        assertEquals(1, results.getJSONObject(1).getInt("count"))
        assertEquals(0, results.getJSONObject(2).length())
        val failed = JSONObject(ProviderResults.failed(BatchFailure.TOO_LARGE, "TransactionTooLargeException"))
        assertEquals(false, failed.getBoolean("ok"))
        assertEquals("tooLarge", failed.getString("reason"))
        assertEquals("TransactionTooLargeException", failed.getString("message"))
    }

    @Test
    fun `an OperationApplicationException is an assert unless an insert got no row`() {
        assertEquals(BatchFailure.ASSERT, ProviderResults.failureOfOperationApplication("Found value 4 when expected 3 for column version"))
        assertEquals(BatchFailure.ASSERT, ProviderResults.failureOfOperationApplication("Expected 1 rows but actual 0"))
        assertEquals(BatchFailure.ASSERT, ProviderResults.failureOfOperationApplication("wrong number of rows: 0"))
        assertEquals(
            BatchFailure.PROVIDER,
            ProviderResults.failureOfOperationApplication("Insert into content://com.android.contacts/settings returned no result"),
        )
        assertEquals(
            BatchFailure.PROVIDER,
            ProviderResults.failureOfOperationApplication("Too many content provider operations between yield points."),
        )
    }

    @Test
    fun `query rows are ProviderRows JSON with escaped text`() {
        val writer = ProviderRowsWriter(listOf("_id", "title", "x"))
        writer.beginRow()
        writer.longCell(9_007_199_254_740_991)
        writer.textCell("a \"quoted\"\\ line\nbreak\u0001 and \u2028")
        writer.nullCell()
        writer.endRow()
        writer.beginRow()
        writer.longCell(2)
        writer.doubleCell(1.5)
        writer.doubleCell(Double.NaN)
        writer.endRow()
        val parsed = JSONObject(writer.finish())
        assertEquals(JSONArray(listOf("_id", "title", "x")).toString(), parsed.getJSONArray("columns").toString())
        val rows = parsed.getJSONArray("rows")
        assertEquals(9_007_199_254_740_991L, rows.getJSONArray(0).getLong(0))
        assertEquals("a \"quoted\"\\ line\nbreak\u0001 and \u2028", rows.getJSONArray(0).getString(1))
        assertTrue(rows.getJSONArray(0).isNull(2))
        assertEquals(1.5, rows.getJSONArray(1).getDouble(1), 0.0)
        assertTrue(rows.getJSONArray(1).isNull(2))
        assertEquals("{\"columns\":[],\"rows\":[]}", ProviderRowsWriter(emptyList()).finish())
    }

    @Test
    fun `photos decode close to the target size and scale their longer side down to it`() {
        assertEquals(1, PhotoScaling.sampleSize(720, 720, 512))
        assertEquals(4, PhotoScaling.sampleSize(4000, 3000, 512))
        assertEquals(512 to 384, PhotoScaling.targetSize(1000, 750, 512))
        assertEquals(96 to 96, PhotoScaling.targetSize(96, 96, 512))
        assertEquals(1 to 512, PhotoScaling.targetSize(3, 4000, 512))
    }
}
