package com.anonymous.bulwarkmobile

import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class EventStreamConnectionTest {
    private val server = MockWebServer().apply { start() }
    private var client = OkHttpClient()

    /** The stream's thread: posts without delay run on it; retries are only recorded, so no test waits for one. */
    private val thread = Executors.newSingleThreadExecutor()
    private val retries = mutableListOf<Long>()
    private val later = object : Later {
        override fun post(runnable: Runnable, delayMs: Long) {
            if (delayMs == 0L) thread.execute(runnable) else retries += delayMs
        }

        override fun cancel(runnable: Runnable) = Unit
    }

    @Volatile private var now = 1_000_000L
    @Volatile private var offline = false
    private val awake = AtomicInteger()

    private val heard = LinkedBlockingQueue<String>()
    private val dueChanges = LinkedBlockingQueue<Unit>()
    private val listener = object : EventStreamConnection.Listener {
        override fun onLive(stream: EventStreamConnection) { heard += "live" }
        override fun onWorking(stream: EventStreamConnection) { heard += "working" }
        override fun onState(stream: EventStreamConnection, data: String) { heard += "state $data" }
        override fun onRefused(stream: EventStreamConnection) { heard += "refused" }
        override fun onProblem(stream: EventStreamConnection, problem: String) { heard += "problem $problem" }
        override fun onDueChanged() {
            dueChanges += Unit
        }
    }

    // Unique per test.
    private val account = DirectPushAccount(
        id = "a${System.nanoTime()}",
        eventSourceUrl = server.url("/eventsource/").toString() + "?types={types}&closeafter={closeafter}&ping={ping}",
        authorization = "Bearer t",
        types = listOf("EmailDelivery", "ContactCard"),
        label = "alice",
    )

    // The service's: the accounts on the floor ping.
    private val floors = HashSet<String>()

    private fun newStream(floorPing: MutableSet<String> = floors) = EventStreamConnection(
        account = account,
        name = "stream 1",
        client = { client },
        later = later,
        clock = { now },
        keepAwake = { _ ->
            awake.incrementAndGet()
            AutoCloseable { awake.decrementAndGet() }
        },
        offline = { offline },
        floorPing = floorPing,
        listener = listener,
    )

    private val stream = newStream()

    private fun <T> onThread(block: () -> T): T = thread.submit(Callable(block)).get(5, TimeUnit.SECONDS)

    private fun next(): String = heard.poll(5, TimeUnit.SECONDS) ?: error("nothing heard")

    /** Connects; what [settle] waits for is the end that follows. */
    private fun connect() = onThread {
        stream.connect()
        dueChanges.clear()
    }

    /** Waits until the connection's end was handled on its thread (it ends by telling when the stream is due). */
    private fun settle() {
        assertNotNull("no end", dueChanges.poll(5, TimeUnit.SECONDS))
    }

    private fun eventStream(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)

    @After
    fun tearDown() {
        onThread { stream.close() }
        thread.shutdownNow()
        server.shutdown()
    }

    @Test
    fun `asks for the stream with the credentials and fills in the template`() {
        server.enqueue(eventStream(""))
        connect()
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("Bearer t", request.getHeader("Authorization"))
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("EmailDelivery,ContactCard", request.requestUrl!!.queryParameter("types"))
        assertEquals("no", request.requestUrl!!.queryParameter("closeafter"))
        assertEquals("${EventStreamConnection.PING_SECONDS}", request.requestUrl!!.queryParameter("ping"))
    }

    @Test
    fun `a state event is handed on, and the stream is live and its credentials work`() {
        val data = "{\"@type\":\"StateChange\",\"changed\":{\"c\":{\"EmailDelivery\":\"s1\"}}}"
        server.enqueue(eventStream("event: ping\ndata: {\"interval\": 120}\n\nevent: state\ndata: $data\n\n"))
        connect()
        assertEquals("live", next())
        val rest = listOf(next(), next()).toSet()
        assertEquals(setOf("working", "state $data"), rest)
        settle()
        // The server closed it after one ping: tried again after the back-off.
        assertEquals(listOf(EventStreamConnection.backoff(0)), retries)
        assertEquals(0, awake.get())
    }

    @Test
    fun `a connection that fails is reported by the kind of failure, never by its message`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        connect()
        val problem = next()
        assertTrue(problem, problem.startsWith("problem failed: "))
        assertFalse(problem, problem.contains(server.hostName) || problem.contains("${server.port}"))
        settle()
        assertEquals(1, retries.size)
    }

    @Test
    fun `after a network change the stream connects anew, not on a pooled connection`() {
        // HTTP/2: one connection outlives its streams and stays pooled.
        server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
        client = OkHttpClient.Builder().protocols(listOf(Protocol.H2_PRIOR_KNOWLEDGE)).build()
        server.enqueue(eventStream(""))
        connect()
        assertEquals("live", next())
        settle()
        client = EventStreamConnection.onNewNetwork(client)
        server.enqueue(eventStream(""))
        onThread { stream.reconnectNow() }
        assertEquals("live", next())
        val first = server.takeRequest(5, TimeUnit.SECONDS)!!
        val second = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals(0, first.sequenceNumber)
        // The first request on its connection: a new one.
        assertEquals(0, second.sequenceNumber)
    }

    @Test
    fun `refused credentials end the stream without a retry`() {
        server.enqueue(MockResponse().setResponseCode(401))
        connect()
        assertEquals("refused", next())
        // The connect wake lock went with the answer.
        assertEquals(0, awake.get())
        assertTrue(retries.isEmpty())
        assertNull(onThread { stream.dueAt() })
    }

    @Test
    fun `an event source that is gone asks for the session again, like a refusal`() {
        server.enqueue(MockResponse().setResponseCode(404))
        connect()
        assertEquals("problem HTTP 404", next())
        assertEquals("refused", next())
        assertTrue(retries.isEmpty())
    }

    @Test
    fun `a server error is retried after the back-off`() {
        server.enqueue(MockResponse().setResponseCode(503))
        connect()
        assertEquals("problem HTTP 503", next())
        settle()
        assertEquals(listOf(EventStreamConnection.backoff(0)), retries)
        assertNotNull(onThread { stream.dueAt() })
    }

    @Test
    fun `a page that is no event stream is not read`() {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("event: state\ndata: {}\n\n"))
        connect()
        assertEquals("problem not an event stream", next())
        settle()
        assertTrue(heard.isEmpty())
        assertEquals(1, retries.size)
    }

    @Test
    fun `without a network a closed stream waits for one instead of retrying`() {
        offline = true
        server.enqueue(MockResponse().setResponseCode(503))
        connect()
        assertEquals("problem HTTP 503", next())
        settle()
        assertTrue(retries.isEmpty())
        assertNull(onThread { stream.dueAt() })
        // The network's return connects it.
        offline = false
        server.enqueue(eventStream(""))
        onThread { stream.retryNow() }
        assertEquals("live", next())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a silent stream is reconnected by the watchdog`() {
        // Sends its first comment, then nothing for 2 s, long after the
        // reconnect: what the replaced connection still reads changes nothing.
        server.enqueue(eventStream(": open\n\n: late\n\n").throttleBody(8, 2, TimeUnit.SECONDS))
        connect()
        assertEquals("live", next())
        val due = onThread { stream.dueAt() }!!
        onThread { stream.check() }
        assertTrue(heard.isEmpty())
        now = due
        server.enqueue(eventStream(""))
        onThread { stream.check() }
        assertEquals("problem silent, reconnecting", next())
        assertEquals("live", next())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a stream closed before its second ping is a failure, and a second in a row asks for the floor ping`() {
        var failures = 0
        var early = 0
        val floors = mutableListOf<Boolean>()
        val delays = (1..4).map {
            val next = EventStreamConnection.reconnect(failures, pings = 1, onTheWay = true, earlyCloses = early)
            floors += next.floorPing
            failures = next.failures
            early = next.earlyCloses
            next.delayMs
        }
        assertEquals(4, failures)
        assertTrue(delays.zipWithNext().all { (a, b) -> b > a })
        assertEquals(listOf(false, true, true, true), floors)
    }

    @Test
    fun `one early close between working streams keeps the ping`() {
        val restart = EventStreamConnection.reconnect(failures = 0, pings = 1, onTheWay = true, earlyCloses = 0)
        assertFalse(restart.floorPing)
        val worked = EventStreamConnection.reconnect(restart.failures, pings = 3, onTheWay = true, earlyCloses = restart.earlyCloses)
        assertEquals(0, worked.earlyCloses)
        val again = EventStreamConnection.reconnect(worked.failures, pings = 0, onTheWay = true, earlyCloses = worked.earlyCloses)
        assertFalse(again.floorPing)
    }

    @Test
    fun `a connection that never went live is a failure, keeps the ping and starts the early closes again`() {
        val next = EventStreamConnection.reconnect(failures = 2, pings = 0, onTheWay = false, earlyCloses = 1)
        assertEquals(3, next.failures)
        assertEquals(EventStreamConnection.backoff(2), next.delayMs)
        assertEquals(0, next.earlyCloses)
        assertFalse(next.floorPing)
    }

    @Test
    fun `a stream that carried two pings starts the count again`() {
        val next = EventStreamConnection.reconnect(failures = 5, pings = 2, onTheWay = true, earlyCloses = 1)
        assertEquals(1, next.failures)
        assertEquals(EventStreamConnection.backoff(0), next.delayMs)
        assertFalse(next.floorPing)
    }

    @Test
    fun `streams the server keeps closing early ask for the floor ping`() {
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) {
            server.enqueue(eventStream(""))
            connect()
            assertEquals("live", next())
            settle()
        }
        assertEquals(
            "problem ended before its second ping ${EventStreamConnection.EARLY_CLOSES_FOR_FLOOR} times, asking for pings every ${EventStreamConnection.PING_FLOOR_SECONDS} s",
            next(),
        )
        server.enqueue(eventStream(""))
        connect()
        val pings = (0..EventStreamConnection.EARLY_CLOSES_FOR_FLOOR).map {
            server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("ping")
        }
        val before = List(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) { "${EventStreamConnection.PING_SECONDS}" }
        assertEquals(before + "${EventStreamConnection.PING_FLOOR_SECONDS}", pings)
    }

    /** One ping, then the connection cut in the middle of the chunked body, as a proxy's read timeout does. */
    private fun cutAfterOnePing() = MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setChunkedBody("event: ping\ndata: {\"interval\": 120}\n\n" + ": padding\n".repeat(50), 64)
        .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)

    @Test
    fun `a body cut in the middle is an error to the reader, not an end`() {
        server.enqueue(cutAfterOnePing())
        val response = client.newCall(okhttp3.Request.Builder().url(server.url("/eventsource/")).build()).execute()
        val error = runCatching { response.body!!.source().readUtf8() }.exceptionOrNull()
        assertTrue("$error", error is java.io.IOException)
    }

    @Test
    fun `streams a proxy keeps cutting before their second ping ask for the floor ping`() {
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) {
            server.enqueue(cutAfterOnePing())
            connect()
            assertEquals("live", next())
            assertEquals("working", next())
            settle()
        }
        assertEquals(
            "problem ended before its second ping ${EventStreamConnection.EARLY_CLOSES_FOR_FLOOR} times, asking for pings every ${EventStreamConnection.PING_FLOOR_SECONDS} s",
            next(),
        )
    }

    @Test
    fun `streams cut while the device has no network do not ask for the floor ping`() {
        offline = true
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) {
            server.enqueue(cutAfterOnePing())
            connect()
            assertEquals("live", next())
            assertEquals("working", next())
            settle()
        }
        server.enqueue(eventStream(""))
        connect()
        val pings = (0..EventStreamConnection.EARLY_CLOSES_FOR_FLOOR).map {
            server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("ping")
        }
        assertEquals(List(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR + 1) { "${EventStreamConnection.PING_SECONDS}" }, pings)
    }

    /** Two streams ended early in a row; the floor is asked for. */
    private fun endEarlyUntilTheFloor() {
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) {
            server.enqueue(eventStream(""))
            connect()
            assertEquals("live", next())
            settle()
        }
        assertTrue(next().startsWith("problem ended before its second ping"))
    }

    private fun pingAsked(): String? = server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("ping")

    @Test
    fun `after a network change the floor ping is left, and early ends that come back bring it back`() {
        endEarlyUntilTheFloor()
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) { pingAsked() }
        // What the service does when the network changed.
        server.enqueue(eventStream(""))
        onThread {
            floors.clear()
            stream.reconnectNow()
        }
        assertEquals("${EventStreamConnection.PING_SECONDS}", pingAsked())
        assertEquals("live", next())
        settle()
        server.enqueue(eventStream(""))
        connect()
        assertEquals("${EventStreamConnection.PING_SECONDS}", pingAsked())
        assertEquals("live", next())
        settle()
        assertTrue(next().startsWith("problem ended before its second ping"))
        server.enqueue(eventStream(""))
        connect()
        assertEquals("${EventStreamConnection.PING_FLOOR_SECONDS}", pingAsked())
    }

    @Test
    fun `a service started again starts its streams without the floor ping`() {
        endEarlyUntilTheFloor()
        repeat(EventStreamConnection.EARLY_CLOSES_FOR_FLOOR) { pingAsked() }
        onThread { stream.close() }
        // The new service's own set; the old one still names the account.
        val again = newStream(HashSet())
        server.enqueue(eventStream(""))
        onThread { again.connect() }
        assertEquals("${EventStreamConnection.PING_SECONDS}", pingAsked())
        onThread { again.close() }
    }
}
