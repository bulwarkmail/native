package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class NotifiedOnceTest {

    /** Rings in memory; [onRead] runs inside every read, after the ring was taken. */
    private class Rings(var onRead: (String) -> Unit = {}) : NotifiedIdsStore {
        val rings = ConcurrentHashMap<String, List<String>>()

        override fun read(accountId: String): List<String> {
            val ring = rings[accountId] ?: emptyList()
            onRead(accountId)
            return ring
        }

        override fun write(accountId: String, ring: List<String>) {
            rings[accountId] = ring
        }

        override fun remove(accountId: String) {
            rings.remove(accountId)
        }
    }

    /**
     * Holds the first thread inside its read until the second has read too,
     * or is waiting for the account's lock: without the lock both read before
     * either writes; with it the second cannot read, and the first goes on.
     */
    private fun rendezvous(arrived: AtomicInteger, other: () -> Thread?, otherDone: () -> Boolean = { false }) {
        arrived.incrementAndGet()
        while (arrived.get() < 2 && other()?.state != Thread.State.BLOCKED && !otherDone()) {
            Thread.onSpinWait()
        }
    }

    private fun Thread.joinOrFail() {
        join(10_000)
        if (isAlive) fail("$name did not finish")
    }

    @Test
    fun `two pushes bringing the same new mail at once post it once`() {
        val posts = AtomicInteger()
        val arrived = AtomicInteger()
        val threads = arrayOfNulls<Thread>(2)
        val rings = Rings { rendezvous(arrived, { threads.firstOrNull { it != Thread.currentThread() } }) }
        val gate = NotifiedOnce()
        val start = CountDownLatch(1)
        for (i in 0..1) {
            threads[i] = thread(start = false, name = "push-$i") {
                start.await()
                gate.post(rings, "alice", listOf("m1")) { posts.incrementAndGet() }
            }
        }
        threads.forEach { it!!.start() }
        start.countDown()
        threads.forEach { it!!.joinOrFail() }

        assertEquals(1, posts.get())
        assertEquals(listOf("m1"), rings.rings["alice"])
    }

    @Test
    fun `forgetting the ring while a push posts is not undone by that push`() {
        val rings = Rings()
        rings.rings["alice"] = listOf("old")
        val arrived = AtomicInteger()
        val removed = CountDownLatch(1)
        lateinit var forgetter: Thread
        rings.onRead = { rendezvous(arrived, { forgetter }, { removed.count == 0L }) }
        val gate = NotifiedOnce()

        val poster = thread(start = false, name = "push") {
            gate.post(rings, "alice", listOf("new")) {}
        }
        forgetter = thread(start = false, name = "sign-out") {
            // Only once the push is reading: it took the ring that is being forgotten.
            while (arrived.get() == 0) Thread.onSpinWait()
            gate.forget(rings, "alice")
            removed.countDown()
        }
        forgetter.start()
        poster.start()
        poster.joinOrFail()
        forgetter.joinOrFail()

        assertNull(rings.rings["alice"])
    }

    @Test
    fun `a push carrying ids posts the new ones and records them newest first`() {
        val rings = Rings()
        val gate = NotifiedOnce()
        val posted = mutableListOf<String>()

        // The native lookup posts a push's mails oldest first, one notification each.
        for (id in listOf("m1", "m2")) gate.post(rings, "alice", listOf(id)) { posted += id }
        assertEquals(listOf("m2", "m1"), rings.rings["alice"])

        // A second push for the same mails and one more: only the new one shows.
        for (id in listOf("m1", "m2", "m3")) gate.post(rings, "alice", listOf(id)) { posted += id }
        assertEquals(listOf("m1", "m2", "m3"), posted)
        assertEquals(listOf("m3", "m2", "m1"), rings.rings["alice"])
    }

    @Test
    fun `a notification for several mails posts unless all of them were notified`() {
        val rings = Rings()
        rings.rings["alice"] = listOf("m1")
        val gate = NotifiedOnce()

        assertTrue(gate.post(rings, "alice", listOf("m2", "m1")) {})
        assertEquals(listOf("m2", "m1"), rings.rings["alice"])
        assertFalse(gate.post(rings, "alice", listOf("m2", "m1")) { fail("posted again") })
    }

    @Test
    fun `a post that fails records nothing and the mail can still be shown`() {
        val rings = Rings()
        rings.rings["alice"] = listOf("m0")
        val gate = NotifiedOnce()

        try {
            gate.post(rings, "alice", listOf("m1")) { throw IllegalStateException("no notification") }
            fail("the failure was swallowed")
        } catch (_: IllegalStateException) {
        }
        assertEquals(listOf("m0"), rings.rings["alice"])

        assertTrue(gate.post(rings, "alice", listOf("m1")) {})
        assertEquals(listOf("m1", "m0"), rings.rings["alice"])
    }

    @Test
    fun `another account's push does not wait for a post in progress`() {
        val rings = Rings()
        val gate = NotifiedOnce()
        val alicePosting = CountDownLatch(1)
        val releaseAlice = CountDownLatch(1)
        val alice = thread(name = "alice") {
            gate.post(rings, "alice", listOf("m1")) {
                alicePosting.countDown()
                releaseAlice.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(alicePosting.await(10, TimeUnit.SECONDS))

        val bob = thread(name = "bob") { gate.post(rings, "bob", listOf("m1")) {} }
        bob.join(10_000)
        val bobDoneWhileAlicePosts = !bob.isAlive && alice.isAlive
        releaseAlice.countDown()
        alice.joinOrFail()

        assertTrue(bobDoneWhileAlicePosts)
        assertEquals(listOf("m1"), rings.rings["bob"])
        assertEquals(listOf("m1"), rings.rings["alice"])
    }
}
