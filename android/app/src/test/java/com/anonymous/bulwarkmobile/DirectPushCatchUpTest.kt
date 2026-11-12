package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class DirectPushCatchUpTest {
    private val later = ManualLater()
    private val woke = mutableListOf<Pair<String, Long>>()
    private var hasStream = true
    private val catchUp = DirectPushCatchUp(later, { later.now }) { id ->
        if (hasStream) woke += id to later.now
        hasStream
    }

    @Test
    fun `a stream that goes live wakes the task at once the first time`() {
        later.advance(1_000)
        catchUp.live("a")
        later.advance(0)
        assertEquals(listOf("a" to 1_000L), woke)
    }

    @Test
    fun `streams that open again and again wake the task at most once a minute, the last opening included`() {
        // An opening every 2 s for an hour.
        repeat(1_800) {
            catchUp.live("a")
            later.advance(2_000)
        }
        later.advance(DirectPushCatchUp.SPACING_MS)
        assertEquals(61, woke.size)
        assertEquals(List(60) { DirectPushCatchUp.SPACING_MS }, woke.map { it.second }.zipWithNext { a, b -> b - a })
    }

    @Test
    fun `accounts are spaced each on their own`() {
        catchUp.live("a")
        catchUp.live("b")
        later.advance(0)
        assertEquals(listOf("a", "b"), woke.map { it.first })
    }

    @Test
    fun `a wake for a stream that is gone does not count`() {
        hasStream = false
        catchUp.live("a")
        later.advance(0)
        hasStream = true
        later.advance(1_000)
        catchUp.live("a")
        later.advance(0)
        assertEquals(listOf("a" to 1_000L), woke)
    }

    @Test
    fun `close cancels the waiting wake`() {
        catchUp.live("a")
        later.advance(0)
        catchUp.live("a")
        catchUp.close()
        later.advance(DirectPushCatchUp.SPACING_MS)
        assertEquals(1, woke.size)
    }
}
