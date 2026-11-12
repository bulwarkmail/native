package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BulwarkDirectPushModuleTest {
    private fun account(id: String) = JavaOnlyMap.of(
        "id", id,
        "eventSourceUrl", "https://mail.example.org/jmap/eventsource/?types={types}",
        "authorization", "Bearer t",
        "types", JavaOnlyArray.of("EmailDelivery"),
        "label", "alice",
    )

    private fun answer(
        vararg accounts: JavaOnlyMap,
        unreadable: JavaOnlyArray = JavaOnlyArray(),
        refused: JavaOnlyArray = JavaOnlyArray(),
    ) = JavaOnlyMap.of(
        "request", 7.0,
        "accounts", JavaOnlyArray.of(*accounts),
        "unreadable", unreadable,
        "refused", refused,
    )

    @Test
    fun `reads an answer`() {
        val read = BulwarkDirectPushModule.readAnswer(
            answer(account("a"), account("b"), unreadable = JavaOnlyArray.of("d"), refused = JavaOnlyArray.of("c")),
        )
        assertEquals(7, read.request)
        assertEquals(listOf("a", "b"), read.accounts.map { it.id })
        assertEquals(listOf("EmailDelivery"), read.accounts[0].types)
        assertEquals("alice", read.accounts[0].label)
        assertEquals(setOf("d"), read.unreadable)
        assertEquals(setOf("c"), read.refused)
    }

    @Test
    fun `an answer with a malformed account is refused whole, not read without it`() {
        val noAuthorization = account("b").apply { putNull("authorization") }
        assertThrows(IllegalArgumentException::class.java) {
            BulwarkDirectPushModule.readAnswer(answer(account("a"), noAuthorization))
        }
        val typeNotString = account("b").apply { putArray("types", JavaOnlyArray.of(1.0)) }
        assertThrows(IllegalArgumentException::class.java) {
            BulwarkDirectPushModule.readAnswer(answer(account("a"), typeNotString))
        }
    }

    @Test
    fun `an account whose stream URL is no URL is refused, and the others are served`() {
        val noUrl = account("b").apply { putString("eventSourceUrl", "mail.example.org/jmap/eventsource/") }
        val read = BulwarkDirectPushModule.readAnswer(answer(account("a"), noUrl, refused = JavaOnlyArray.of("c")))
        assertEquals(listOf("a"), read.accounts.map { it.id })
        assertEquals(setOf("b", "c"), read.refused)
        assertTrue(read.unreadable.isEmpty())
    }

    @Test
    fun `the error names the key, never the value`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            BulwarkDirectPushModule.readAnswer(answer(account("a").apply { putDouble("authorization", 1.0) }))
        }
        assertTrue(e.message!!.contains("authorization"))
        assertFalse(e.message!!.contains("Bearer"))
    }

    @Test
    fun `a request that is no whole number is refused`() {
        for (bad in listOf(1.5, -1.0)) {
            val map = answer().apply { putDouble("request", bad) }
            assertThrows(IllegalArgumentException::class.java) { BulwarkDirectPushModule.readAnswer(map) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BulwarkDirectPushModule.readAnswer(JavaOnlyMap.of("accounts", JavaOnlyArray(), "unreadable", JavaOnlyArray(), "refused", JavaOnlyArray()))
        }
    }

    @Test
    fun `texts need every string`() {
        val texts = BulwarkDirectPushModule.readTexts(
            JavaOnlyMap.of("channelName", "c", "title", "t", "text", "x", "stoppedText", "s", "problemChannelName", "p"),
        )
        assertEquals(DirectPushSettings.Texts("c", "t", "x", "s", "p"), texts)
        assertThrows(IllegalArgumentException::class.java) {
            BulwarkDirectPushModule.readTexts(JavaOnlyMap.of("channelName", "c", "title", "t", "text", "x"))
        }
    }
}
