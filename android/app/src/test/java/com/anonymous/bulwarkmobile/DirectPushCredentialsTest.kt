package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectPushCredentialsTest {
    private val later = ManualLater()

    /** The headless task: records each request it was started for; the test ends or answers them. */
    private inner class Task : DirectPushCredentials.Task {
        val started = mutableListOf<Int>()
        val startedAt = mutableListOf<Long>()
        val ends = mutableMapOf<Int, () -> Unit>()
        var held = false

        override fun start(request: Int, ended: () -> Unit) {
            started += request
            startedAt += later.now
            ends[request] = ended
            held = true
        }

        override fun stop() {
            held = false
        }
    }

    private inner class Listener : DirectPushCredentials.Listener {
        val applied = mutableListOf<Pair<List<String>, Set<String>>>()
        val givenUp = mutableListOf<Int>()

        override fun apply(accounts: List<DirectPushAccount>, unreadable: Set<String>, refused: Set<String>) {
            applied += accounts.map { it.id } to refused
        }

        override fun onGivenUp(refusals: Int) {
            givenUp += refusals
        }

        override fun onDueChanged() = Unit
    }

    private val task = Task()
    private val listener = Listener()
    // Numbered from 1 for this test; the service's numbers are process-wide (see the last test).
    private var requests = 0
    private val credentials = DirectPushCredentials(later, { later.now }, task, listener) { ++requests }

    private fun account(id: String) = DirectPushAccount(id, "https://mail.example.org/jmap/eventsource/", "Bearer t", listOf("EmailDelivery"), id)

    private fun answer(request: Int, vararg ids: String, unreadable: Set<String> = emptySet(), refused: Set<String> = emptySet()) =
        credentials.answer(DirectPushCredentials.Answer(request, ids.map(::account), unreadable, refused))

    private val timeoutMs = DirectPushCredentials.ANSWER_TIMEOUT_MS

    /** Moves the clock until the next request starts, or by the longest back-off when none does. */
    private fun untilNextRequest() {
        val before = task.started.size
        var waited = 0L
        while (task.started.size == before && waited < EventStreamConnection.backoff(Int.MAX_VALUE)) {
            later.advance(1_000)
            waited += 1_000
        }
    }

    @Test
    fun `the answer to the pending request is applied and nothing more is asked`() {
        credentials.restart()
        answer(1, "a", "b")
        assertEquals(listOf(listOf("a", "b") to emptySet<String>()), listener.applied)
        assertTrue(credentials.isIdle)
        assertFalse(task.held)
        later.advance(timeoutMs * 2)
        assertEquals(listOf(1), task.started)
    }

    @Test
    fun `a start after an applied answer asks again`() {
        credentials.restart()
        answer(1, "a")
        credentials.restart()
        assertEquals(listOf(1, 2), task.started)
        answer(2, "a", "b")
        assertEquals(listOf("a", "b"), listener.applied.last().first)
    }

    @Test
    fun `an answer that comes after the timeout is dropped, and the request is made again later`() {
        credentials.restart()
        later.advance(timeoutMs)
        assertFalse(task.held)
        answer(1, "a")
        assertTrue(listener.applied.isEmpty())
        assertFalse(credentials.isIdle)
        later.advance(EventStreamConnection.backoff(1))
        assertEquals(listOf(1, 2), task.started)
        answer(2, "a")
        assertEquals(listOf("a"), listener.applied.single().first)
    }

    @Test
    fun `a start while a request is pending drops its answer and asks again at once`() {
        credentials.restart()
        credentials.restart()
        assertEquals(listOf(1), task.started)
        answer(1, "old")
        assertTrue(listener.applied.isEmpty())
        assertEquals(listOf(1, 2), task.started)
        answer(2, "new")
        assertEquals(listOf("new"), listener.applied.single().first)
    }

    @Test
    fun `a task that ends without an answer is asked again with growing back-off`() {
        credentials.restart()
        val endedAt = mutableListOf<Long>()
        repeat(4) {
            task.ends.getValue(task.started.last())()
            endedAt += later.now
            untilNextRequest()
        }
        val waits = task.startedAt.drop(1).zip(endedAt) { started, ended -> started - ended }
        assertEquals((1..4).map { EventStreamConnection.backoff(it) }, waits)
        assertTrue(waits.zipWithNext().all { (a, b) -> b > a })
        // Its late end changes nothing.
        task.ends.getValue(1)()
        assertEquals(5, task.started.size)
    }

    @Test
    fun `an answer that could not read an account is applied and asked again later`() {
        credentials.restart()
        answer(1, "a", unreadable = setOf("b"))
        assertEquals(listOf("a"), listener.applied.single().first)
        assertFalse(credentials.isIdle)
        later.advance(EventStreamConnection.backoff(1))
        assertEquals(listOf(1, 2), task.started)
    }

    @Test
    fun `a stream refused a few times in a row is given up on until the next start`() {
        credentials.restart()
        answer(1, "a", "b")
        repeat(DirectPushCredentials.MAX_REFUSALS) {
            credentials.refused("a")
            untilNextRequest()
            if (task.held) answer(task.started.last(), "a", "b")
        }
        assertEquals(listOf(DirectPushCredentials.MAX_REFUSALS), listener.givenUp)
        assertEquals(DirectPushCredentials.MAX_REFUSALS, task.started.size)
        assertTrue(credentials.isIdle)
        // Given up on: left out of the next answer, which another refusal asks for.
        credentials.refused("b")
        untilNextRequest()
        answer(task.started.last(), "a", "b")
        assertEquals(listOf("b"), listener.applied.last().first)
        // A start asks for it again.
        credentials.restart()
        answer(task.started.last(), "a", "b")
        assertEquals(listOf("a", "b"), listener.applied.last().first)
    }

    @Test
    fun `an event in between starts the count of refusals again`() {
        credentials.restart()
        answer(1, "a")
        repeat(DirectPushCredentials.MAX_REFUSALS * 2) {
            credentials.refused("a")
            untilNextRequest()
            answer(task.started.last(), "a")
            credentials.working("a")
        }
        assertTrue(listener.givenUp.isEmpty())
    }

    @Test
    fun `a session refused in the task counts like a refused stream`() {
        credentials.restart()
        answer(1, refused = setOf("a"))
        later.advance(EventStreamConnection.backoff(1))
        answer(2, refused = setOf("a"))
        later.advance(EventStreamConnection.backoff(2))
        answer(3, refused = setOf("a"))
        assertEquals(listOf(DirectPushCredentials.MAX_REFUSALS), listener.givenUp)
        untilNextRequest()
        assertEquals(3, task.started.size)
        assertTrue(credentials.isIdle)
    }

    @Test
    fun `a stopped instance's late answer is not taken by the next one`() {
        val firstTask = Task()
        val first = DirectPushCredentials(later, { later.now }, firstTask, Listener())
        first.restart()
        first.close()
        val nextTask = Task()
        val nextListener = Listener()
        val next = DirectPushCredentials(later, { later.now }, nextTask, nextListener)
        next.restart()
        next.answer(DirectPushCredentials.Answer(firstTask.started.single(), listOf(account("old")), emptySet(), emptySet()))
        assertTrue(nextListener.applied.isEmpty())
        next.answer(DirectPushCredentials.Answer(nextTask.started.single(), listOf(account("new")), emptySet(), emptySet()))
        assertEquals(listOf("new"), nextListener.applied.single().first)
    }

    /** A device asleep: the elapsed clock moves on, but nothing posted through [Later] runs. */
    private inner class Asleep {
        var now = 0L
        val task = Task()
        private val never = object : Later {
            override fun post(runnable: Runnable, delayMs: Long) = Unit

            override fun cancel(runnable: Runnable) = Unit
        }
        val credentials = DirectPushCredentials(never, { now }, task, Listener()) { ++requests }
    }

    @Test
    fun `a retry after an answer that could not read an account is made at the watchdog's turn once its time has come, though the device slept`() {
        val asleep = Asleep()
        asleep.credentials.restart()
        asleep.credentials.answer(DirectPushCredentials.Answer(1, listOf(account("a")), setOf("b"), emptySet()))
        asleep.now += EventStreamConnection.backoff(1) - 1
        asleep.credentials.check()
        assertEquals(1, asleep.task.started.size)
        asleep.now += 1
        asleep.credentials.check()
        assertEquals(2, asleep.task.started.size)
    }

    @Test
    fun `a refused stream's request is made at the watchdog's turn once its time has come, though the device slept`() {
        val asleep = Asleep()
        asleep.credentials.restart()
        asleep.credentials.answer(DirectPushCredentials.Answer(1, listOf(account("a")), emptySet(), emptySet()))
        asleep.credentials.refused("a")
        assertEquals(EventStreamConnection.backoff(1), asleep.credentials.retryAt)
        assertFalse(asleep.credentials.isIdle)
        asleep.now += 10 * 60_000L
        asleep.credentials.check()
        assertEquals(2, asleep.task.started.size)
    }

    @Test
    fun `the network's return makes a waiting request at once`() {
        val asleep = Asleep()
        asleep.credentials.restart()
        asleep.credentials.answer(DirectPushCredentials.Answer(1, listOf(account("a")), setOf("b"), emptySet()))
        asleep.credentials.retryNow()
        assertEquals(2, asleep.task.started.size)
        assertEquals(null, asleep.credentials.retryAt)
        // Nothing waits: the network's return asks for nothing.
        asleep.credentials.answer(DirectPushCredentials.Answer(2, listOf(account("a")), emptySet(), emptySet()))
        asleep.credentials.retryNow()
        assertEquals(2, asleep.task.started.size)
    }
}
