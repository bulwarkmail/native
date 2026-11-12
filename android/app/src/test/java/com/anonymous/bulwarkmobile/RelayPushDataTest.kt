package com.anonymous.bulwarkmobile

import com.anonymous.bulwarkmobile.sync.DeviceSyncAccounts
import com.anonymous.bulwarkmobile.sync.PushRouting
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayPushDataTest {
    // As Stalwart writes it (crates/jmap/src/api/event_source.rs).
    private val stateChange = "{\"@type\":\"StateChange\",\"changed\":{\"c\":{\"EmailDelivery\":\"s1\",\"Email\":\"s1\"},\"team\":{\"ContactCard\":\"s2\"}}}"

    @Test
    fun `a StateChange becomes one push with its whole map`() {
        val push = RelayPushData.ofStateChange(stateChange, "alice")!!
        assertEquals("jmap-state-change", push["kind"])
        assertEquals("alice", push["accountLabel"])
        assertNull(push["accountId"])
        assertEquals("[]", push["emailIds"])
        val changed = JSONObject(push["changed"]!!)
        assertEquals(setOf("c", "team"), changed.keys().asSequence().toSet())
        assertEquals("s1", changed.getJSONObject("c").getString("EmailDelivery"))
        assertEquals(setOf("ContactCard"), changed.getJSONObject("team").keys().asSequence().toSet())
    }

    @Test
    fun `the push of a StateChange is routed like the relay's`() {
        val routes = mapOf("team" to listOf(PushRouting.Route("bob", setOf(DeviceSyncAccounts.CONTACTS_AUTHORITY))))
        val push = RelayPushData.ofStateChange(stateChange, "")!!
        val decision = PushRouting.decide(push, routes)
        assertTrue(decision.startMailTask)
        assertEquals(setOf("bob" to DeviceSyncAccounts.CONTACTS_AUTHORITY), decision.syncs)
        assertNull(push["accountLabel"])
        val contactsOnly = RelayPushData.ofStateChange("{\"@type\":\"StateChange\",\"changed\":{\"team\":{\"ContactCard\":\"s2\"}}}", "")!!
        assertFalse(PushRouting.decide(contactsOnly, routes).startMailTask)
    }

    @Test
    fun `anything but a StateChange is no push`() {
        assertNull(RelayPushData.ofStateChange("{\"interval\": 120}", "alice"))
        assertNull(RelayPushData.ofStateChange("not json", "alice"))
        assertNull(RelayPushData.ofStateChange("{\"@type\":\"StateChange\",\"changed\":{}}", "alice"))
    }

    @Test
    fun `the catch-up push is a mail push without ids for the account`() {
        val push = RelayPushData.catchUp("alice")
        assertEquals(mapOf("kind" to "jmap-state-change", "accountLabel" to "alice", "emailIds" to "[]"), push)
        val decision = PushRouting.decide(push, emptyMap())
        assertTrue(decision.startMailTask)
        assertTrue(decision.syncs.isEmpty())
        assertFalse("accountLabel" in RelayPushData.catchUp(""))
    }

    @Test
    fun `UnifiedPush flattens the relay's payload to the same map as before`() {
        val relay = "{\"kind\":\"jmap-state-change\",\"accountLabel\":\"alice\",\"accountId\":\"c\",\"changed\":{\"c\":{\"Email\":\"s1\"}}}"
        assertEquals(
            mapOf(
                "kind" to "jmap-state-change",
                "accountLabel" to "alice",
                "accountId" to "c",
                "emailIds" to "[]",
                "changed" to "{\"c\":{\"Email\":\"s1\"}}",
            ),
            BulwarkUnifiedPushService.parsePayload(relay.toByteArray()),
        )
        // An EmailPush: no kind, no changed, which still reaches the task as "{}".
        assertEquals(
            mapOf("emailIds" to "[\"e1\"]", "changed" to "{}"),
            BulwarkUnifiedPushService.parsePayload("{\"emailIds\":[\"e1\"]}".toByteArray()),
        )
    }
}
