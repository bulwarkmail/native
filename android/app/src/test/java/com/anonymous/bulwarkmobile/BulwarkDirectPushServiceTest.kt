package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BulwarkDirectPushServiceTest {
    @Test
    fun `a stream keeps its account's number in the log when it is replaced`() {
        val slots = HashMap<String, Int>()
        val names = listOf("a", "b", "a", "c", "b").map { BulwarkDirectPushService.streamName(slots, it) }
        assertEquals(listOf("stream 1", "stream 2", "stream 1", "stream 3", "stream 2"), names)
    }

    @Test
    fun `an answer closes every stream it does not name, refused or not`() {
        val close = BulwarkDirectPushService.streamsToClose(
            current = setOf("a", "b", "c"),
            wanted = setOf("a", "d"),
            unreadable = emptySet(),
        )
        assertEquals(setOf("b", "c"), close)
    }

    @Test
    fun `a stream whose account could not be read stays, and a refused one closes`() {
        val close = BulwarkDirectPushService.streamsToClose(
            current = setOf("a", "b", "c"),
            wanted = setOf("a"),
            unreadable = setOf("b"),
        )
        assertEquals(setOf("c"), close)
    }

    @Test
    fun `an account gone from an answer that could not read another one has its stream closed`() {
        // Signed out of a while b's server is unreachable.
        val close = BulwarkDirectPushService.streamsToClose(
            current = setOf("a", "b"),
            wanted = emptySet(),
            unreadable = setOf("b"),
        )
        assertEquals(setOf("a"), close)
    }

    @Test
    fun `the first network connects nothing again`() {
        assertFalse(BulwarkDirectPushService.reconnects(previous = null, lost = false, available = "wifi"))
    }

    @Test
    fun `the same network, not lost, connects nothing again`() {
        assertFalse(BulwarkDirectPushService.reconnects(previous = "wifi", lost = false, available = "wifi"))
    }

    @Test
    fun `a network back after its loss, or another network, reconnects every stream`() {
        assertTrue(BulwarkDirectPushService.reconnects(previous = "wifi", lost = true, available = "wifi"))
        assertTrue(BulwarkDirectPushService.reconnects(previous = "wifi", lost = false, available = "mobile"))
        assertTrue(BulwarkDirectPushService.reconnects(previous = "wifi", lost = true, available = "mobile"))
    }
}
