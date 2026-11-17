package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RefreshBackoffTest {

    @Test
    fun `the wait doubles from 30 s with each failure in a row and stops at 30 min`() {
        val backoff = RefreshBackoff()
        assertEquals(0L, backoff.waitingMs("r1", 0L))
        val waits = (1..10).map {
            backoff.failed("r1", 0L, null)
            backoff.waitingMs("r1", 0L)
        }
        assertEquals(
            listOf(30_000L, 60_000L, 120_000L, 240_000L, 480_000L, 960_000L, 1_800_000L, 1_800_000L, 1_800_000L, 1_800_000L),
            waits,
        )
        assertEquals(1_000L, backoff.waitingMs("r1", 1_799_000L))
        assertEquals(0L, backoff.waitingMs("r1", 1_800_000L))
    }

    @Test
    fun `a longer Retry-After wins, up to the cap`() {
        val backoff = RefreshBackoff()
        backoff.failed("r1", 0L, 300_000L)
        assertEquals(300_000L, backoff.waitingMs("r1", 0L))
        backoff.failed("r2", 0L, 5_000L)
        assertEquals(30_000L, backoff.waitingMs("r2", 0L))
        backoff.failed("r3", 0L, 24L * 60 * 60 * 1000)
        assertEquals(1_800_000L, backoff.waitingMs("r3", 0L))
    }

    @Test
    fun `a refresh that worked clears the wait, and other tokens never wait`() {
        val backoff = RefreshBackoff()
        backoff.failed("r1", 0L, null)
        backoff.failed("r1", 0L, null)
        assertEquals(0L, backoff.waitingMs("q1", 0L))
        backoff.succeeded("r1")
        assertEquals(0L, backoff.waitingMs("r1", 0L))
        backoff.failed("r1", 0L, null)
        assertEquals(30_000L, backoff.waitingMs("r1", 0L))
    }

    @Test
    fun `the oldest entry goes when the table is full`() {
        val backoff = RefreshBackoff(capacity = 2)
        backoff.failed("r1", 0L, null)
        backoff.failed("r2", 0L, null)
        backoff.failed("r3", 0L, null)
        assertEquals(0L, backoff.waitingMs("r1", 0L))
        assertEquals(30_000L, backoff.waitingMs("r2", 0L))
        assertEquals(30_000L, backoff.waitingMs("r3", 0L))
    }

    @Test
    fun `Retry-After is read in seconds only`() {
        assertEquals(120_000L, RefreshBackoff.retryAfterMs("120"))
        assertEquals(120_000L, RefreshBackoff.retryAfterMs(" 120 "))
        assertNull(RefreshBackoff.retryAfterMs("0"))
        assertNull(RefreshBackoff.retryAfterMs(null))
        assertNull(RefreshBackoff.retryAfterMs("Wed, 18 Nov 2026 12:00:00 GMT"))
    }
}
