package com.anonymous.bulwarkmobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRoutingTest {
    private val contacts = "com.android.contacts"
    private val calendar = "com.android.calendar"

    private val routes = PushRouting.parseRoutes(
        """
        {
          "c": [{ "accountName": "alice@example.org", "authorities": ["$contacts", "$calendar"] }],
          "team": [
            { "accountName": "alice@example.org", "authorities": ["$contacts"] },
            { "accountName": "alice-work", "authorities": ["$calendar"] }
          ]
        }
        """.trimIndent(),
        strict = true,
    )

    private fun stateChange(changed: String) = mapOf(
        "kind" to "jmap-state-change",
        "accountLabel" to "alice",
        "accountId" to "c",
        "emailIds" to "[]",
        "changed" to changed,
    )

    @Test
    fun `a contact change requests a contacts sync and no mail task`() {
        val decision = PushRouting.decide(stateChange("""{"c":{"ContactCard":"s1"}}"""), routes)
        assertEquals(setOf("alice@example.org" to contacts), decision.syncs)
        assertFalse(decision.startMailTask)
    }

    @Test
    fun `calendar types request calendar syncs of the routed accounts only`() {
        val decision = PushRouting.decide(stateChange("""{"team":{"Calendar":"s1","CalendarEvent":"s2"}}"""), routes)
        assertEquals(setOf("alice-work" to calendar), decision.syncs)
        assertFalse(decision.startMailTask)
    }

    @Test
    fun `every account key is routed, not only the one repeated as accountId`() {
        val decision = PushRouting.decide(
            stateChange("""{"c":{"AddressBook":"s1"},"team":{"ContactCard":"s2","CalendarEvent":"s3"}}"""),
            routes,
        )
        // alice@example.org's contacts sync is requested once.
        assertEquals(setOf("alice@example.org" to contacts, "alice-work" to calendar), decision.syncs)
    }

    @Test
    fun `mail anywhere in the map starts the mail task, next to the syncs`() {
        val decision = PushRouting.decide(
            stateChange("""{"team":{"CalendarEvent":"s1"},"c":{"EmailDelivery":"s2","Email":"s3"}}"""),
            routes,
        )
        assertTrue(decision.startMailTask)
        assertEquals(setOf("alice-work" to calendar), decision.syncs)
    }

    @Test
    fun `an Email or Mailbox change is possible mail, as a subscription from an older build sends it`() {
        for (changed in listOf(
            """{"c":{"Email":"s1","Mailbox":"s2"}}""",
            """{"c":{"Email":"s1"}}""",
            """{"c":{"Mailbox":"s1"}}""",
        )) {
            val decision = PushRouting.decide(stateChange(changed), routes)
            assertTrue("changed=$changed", decision.startMailTask)
            assertTrue("changed=$changed", decision.syncs.isEmpty())
        }
        val mixed = PushRouting.decide(stateChange("""{"team":{"CalendarEvent":"e1"},"c":{"Email":"s1"}}"""), routes)
        assertTrue(mixed.startMailTask)
        assertEquals(setOf("alice-work" to calendar), mixed.syncs)
        // Types that are neither mail nor device sync say nothing about mail.
        val other = PushRouting.decide(stateChange("""{"c":{"Thread":"t1","ContactCard":"s1"}}"""), routes)
        assertFalse(other.startMailTask)
        assertEquals(setOf("alice@example.org" to contacts), other.syncs)
    }

    @Test
    fun `an email push always starts the mail task`() {
        val data = mapOf("kind" to "jmap-email-push", "accountId" to "c", "changed" to """{"c":{"EmailDelivery":"s"}}""")
        assertTrue(PushRouting.decide(data, routes).startMailTask)
        assertTrue(PushRouting.decide(mapOf("kind" to "jmap-email-push"), routes).startMailTask)
    }

    @Test
    fun `payloads without a readable map are legacy mail pushes`() {
        for (changed in listOf(null, "", "{}", "not json", "[1]", """{"c":{}}""")) {
            val data = stateChange(changed ?: "").let { if (changed == null) it - "changed" else it }
            val decision = PushRouting.decide(data, routes)
            assertTrue("changed=$changed", decision.startMailTask)
            assertTrue("changed=$changed", decision.syncs.isEmpty())
        }
    }

    @Test
    fun `an unreadable account entry may be mail`() {
        val decision = PushRouting.decide(stateChange("""{"c":"garbled","team":{"ContactCard":"s"}}"""), routes)
        assertTrue(decision.startMailTask)
        assertEquals(setOf("alice@example.org" to contacts), decision.syncs)
    }

    @Test
    fun `reads a push the same way as the push task`() {
        // kind (null: none), changed (null: none) → whether the mail task starts. The
        // same table as MAIL_CASES in src/lib/__tests__/push-background-task.test.ts,
        // whose carriesNoMail must agree.
        val state = "jmap-state-change"
        val emailPush = "jmap-email-push"
        val cases: List<Triple<String?, String?, Boolean>> = listOf(
            // No readable map: as before device sync.
            Triple(state, null, true),
            Triple(state, "", true),
            Triple(state, "not json", true),
            Triple(state, "[1]", true),
            Triple(state, "{}", true),
            // A map that names no type is read like a missing one.
            Triple(state, """{"c":{}}""", true),
            Triple(state, """{"c":{},"team":{}}""", true),
            // An account entry that can't be read may be mail.
            Triple(state, """{"c":null}""", true),
            Triple(state, """{"c":"garbled","team":{"ContactCard":"s"}}""", true),
            Triple(state, """{"c":[],"team":{"ContactCard":"s"}}""", true),
            Triple(state, """{"c":5}""", true),
            // Mail types anywhere in the map.
            Triple(state, """{"c":{"EmailDelivery":"s"}}""", true),
            Triple(state, """{"c":{"Email":"s"}}""", true),
            Triple(state, """{"c":{"Mailbox":"s"}}""", true),
            Triple(state, """{"c":{"ContactCard":"s1"},"team":{"EmailDelivery":"s2"}}""", true),
            // Only a StateChange can say it carries no mail.
            Triple(null, """{"c":{"ContactCard":"s"}}""", true),
            Triple(emailPush, """{"c":{"EmailDelivery":"s"}}""", true),
            Triple(emailPush, null, true),
            // Contact and calendar changes, and types that say nothing about mail.
            Triple(state, """{"c":{"ContactCard":"s1","AddressBook":"s2"}}""", false),
            Triple(state, """{"c":{"CalendarEvent":"e1"},"team":{"Calendar":"c1"}}""", false),
            Triple(state, """{"c":{"ContactCard":"s"},"team":{}}""", false),
            Triple(state, """{"elsewhere":{"ContactCard":"s"}}""", false),
            Triple(state, """{"c":{"Thread":"t1","ContactCard":"s1"}}""", false),
        )
        for ((kind, changed, mail) in cases) {
            val data = buildMap<String, String> {
                if (kind != null) put("kind", kind)
                put("accountLabel", "alice")
                put("accountId", "c")
                put("emailIds", "[]")
                if (changed != null) put("changed", changed)
            }
            assertEquals("kind=$kind changed=$changed", mail, PushRouting.decide(data, routes).startMailTask)
        }
    }

    @Test
    fun `accounts without routes are ignored`() {
        val decision = PushRouting.decide(stateChange("""{"elsewhere":{"ContactCard":"s"}}"""), routes)
        assertTrue(decision.syncs.isEmpty())
        assertFalse(decision.startMailTask)
        assertTrue(PushRouting.decide(stateChange("""{"c":{"ContactCard":"s"}}"""), emptyMap()).syncs.isEmpty())
    }

    @Test
    fun `stored routes are validated strictly and read leniently`() {
        val bad = listOf(
            "[]",
            """{"c":{}}""",
            """{"c":[{"authorities":["$contacts"]}]}""",
            """{"c":[{"accountName":"a","authorities":["com.example.tasks"]}]}""",
        )
        for (json in bad) {
            try {
                PushRouting.parseRoutes(json, strict = true)
                throw AssertionError("accepted $json")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
        assertEquals(emptyMap<String, List<PushRouting.Route>>(), PushRouting.parseRoutes("[]"))
        assertEquals(
            mapOf("c" to listOf(PushRouting.Route("a", setOf(contacts)))),
            PushRouting.parseRoutes("""{"c":[{"accountName":"a","authorities":["$contacts","com.example.tasks"]},{"x":1}]}"""),
        )
        assertEquals(emptyMap<String, List<PushRouting.Route>>(), PushRouting.parseRoutes(null))
    }
}
