package com.anonymous.bulwarkmobile

import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * One account's JMAP event stream (RFC 8620 §7.3), kept open: connected,
 * read, and connected again after it ended, with back-off. Its methods run
 * on the thread [later] posts to (the main thread); the stream is read on
 * OkHttp's, which hands back to it through [later] and calls only
 * [Listener.onState] itself.
 */
class EventStreamConnection(
    val account: DirectPushAccount,
    /** What the log calls it: never the account, which is the user's address. */
    val name: String,
    /** The client to connect through, asked at every connection: it changes with the network ([onNewNetwork]). */
    private val client: () -> OkHttpClient,
    private val later: Later,
    private val clock: () -> Long,
    /** Holds the device awake for up to the given time, until the returned handle is closed. */
    private val keepAwake: (Long) -> AutoCloseable,
    /** Whether the device has no network: then a closed stream waits for one rather than retrying. */
    private val offline: () -> Boolean,
    /**
     * Accounts whose streams ask for the server's shortest ping: the
     * service's, which empties it when the network changes and starts with
     * it empty, so the floor is tried without again then.
     */
    private val floorPing: MutableSet<String>,
    private val listener: Listener,
) {
    interface Listener {
        /** The stream went live: the server says nothing of what changed while it was not. */
        fun onLive(stream: EventStreamConnection)

        /** The first event of a connection: the credentials work. */
        fun onWorking(stream: EventStreamConnection)

        /** A `state` event's data, on the thread reading the stream. */
        fun onState(stream: EventStreamConnection, data: String)

        /** The server refused the stream (or no longer has it): the credentials are to be asked for again. */
        fun onRefused(stream: EventStreamConnection)

        /** Something the log should say about this stream. */
        fun onProblem(stream: EventStreamConnection, problem: String)

        /** When the stream next needs a look ([dueAt]) changed. */
        fun onDueChanged()
    }

    // Read on OkHttp's thread too, to drop what a replaced connection still reads.
    @Volatile private var current: Connection? = null
    private var closed = false
    private var failures = 0
    // Streams in a row that ended before their second ping, by something on the way (reconnect).
    private var earlyCloses = 0
    private var retryAt = 0L
    private val retry = Runnable { connect() }

    fun connect() {
        if (closed) return
        later.cancel(retry)
        retryAt = 0L
        current?.cancel()
        current = Connection(if (account.id in floorPing) PING_FLOOR_SECONDS else PING_SECONDS).also { it.open() }
        listener.onDueChanged()
    }

    /** When the watchdog has something to do for this stream: it is found silent, or its retry is due. */
    fun dueAt(): Long? {
        val connection = current
        return when {
            closed -> null
            connection != null -> connection.lastByteAt + connection.pingMs * 2 + PING_GRACE_MS
            retryAt > 0 -> retryAt
            else -> null
        }
    }

    /** The watchdog's look: reconnect a stream that missed its pings, or one whose retry was due while asleep. */
    fun check() {
        val due = dueAt() ?: return
        if (clock() < due) return
        if (current != null) {
            listener.onProblem(this, "silent, reconnecting")
            reconnectNow()
        } else {
            connect()
        }
    }

    /** The network is back: a stream waiting for it, or for its retry, connects now. */
    fun retryNow() {
        if (current == null) reconnectNow()
    }

    /** The network changed: an open stream's socket is dead without knowing it. The counts start again. */
    fun reconnectNow() {
        failures = 0
        earlyCloses = 0
        connect()
    }

    fun close() {
        closed = true
        later.cancel(retry)
        current?.cancel()
        current = null
    }

    /** [connection], the current one, ended; called through [Connection.onMain]. */
    private fun ended(connection: Connection, end: End) {
        current = null
        if (end == End.REFUSED) {
            listener.onRefused(this)
            return
        }
        // A cut without a network is the network's loss, not something on the way.
        val onTheWay = end == End.CLOSED || (end == End.CUT && !offline())
        val next = reconnect(failures, connection.pings, onTheWay, earlyCloses)
        failures = next.failures
        earlyCloses = next.earlyCloses
        if (next.floorPing && floorPing.add(account.id)) {
            listener.onProblem(this, "ended before its second ping ${next.earlyCloses} times, asking for pings every $PING_FLOOR_SECONDS s")
        }
        // The network's return reconnects every stream (retryNow).
        if (!offline()) {
            retryAt = clock() + next.delayMs
            later.post(retry, next.delayMs)
        }
        listener.onDueChanged()
    }

    /** [CLOSED] and [CUT]: the stream went live, then the body ended or broke off; [BROKEN]: it never went live. */
    private enum class End { CLOSED, CUT, BROKEN, REFUSED }

    /** One call to the server; what it learns is its own, so a cancelled one that still reads changes nothing. */
    private inner class Connection(pingSeconds: Int) : Callback {
        private val call: Call = client().newCall(
            Request.Builder()
                .url(streamUrl(account.eventSourceUrl, account.types, pingSeconds))
                .header("Authorization", account.authorization)
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .build(),
        )
        // Long enough for the handshake should the device fall asleep.
        private val awake = keepAwake(CONNECT_WAKE_LOCK_MS)

        @Volatile var lastByteAt = clock()
            private set

        @Volatile var pingMs = pingSeconds * 1000L
            private set

        @Volatile var pings = 0
            private set

        private val isCurrent: Boolean get() = current === this

        fun open() = call.enqueue(this)

        fun cancel() {
            call.cancel()
            awake.close()
        }

        override fun onFailure(call: Call, e: IOException) {
            awake.close()
            // The class only: the message can name the host or its address.
            report("failed: ${e.javaClass.simpleName}")
            onMain { ended(this, End.BROKEN) }
        }

        override fun onResponse(call: Call, response: Response) {
            awake.close()
            var end = End.BROKEN
            try {
                end = read(response)
            } catch (_: IOException) {
                // Closed, cancelled or broken: retried.
            } finally {
                onMain { ended(this, end) }
            }
        }

        /** On OkHttp's thread until the stream ends. */
        private fun read(response: Response): End = response.use {
            when {
                it.code == 401 || it.code == 403 -> return End.REFUSED
                // Not found or gone: the session's event source moved, which
                // the next session read tells.
                it.code == 404 || it.code == 410 -> {
                    report("HTTP ${it.code}")
                    return End.REFUSED
                }
                !it.isSuccessful -> {
                    report("HTTP ${it.code}")
                    return End.BROKEN
                }
                // A captive portal or a proxy's page answers 200 too.
                !isEventStream(it.header("Content-Type")) -> {
                    report("not an event stream")
                    return End.BROKEN
                }
            }
            onMain { listener.onLive(this@EventStreamConnection) }
            val parser = EventStreamParser()
            val buffer = ByteArray(8192)
            val input = (it.body ?: return End.BROKEN).byteStream()
            var working = false
            return try {
                var n = input.read(buffer)
                while (n >= 0) {
                    lastByteAt = clock()
                    for (event in parser.feed(buffer, n)) {
                        when (event.type) {
                            "ping" -> {
                                pings++
                                pingInterval(event.data)?.let { s -> pingMs = s * 1000L }
                            }
                            "state" -> if (isCurrent) listener.onState(this@EventStreamConnection, event.data)
                        }
                        if (!working) {
                            working = true
                            onMain { listener.onWorking(this@EventStreamConnection) }
                        }
                    }
                    n = input.read(buffer)
                }
                End.CLOSED
            } catch (_: IOException) {
                // A proxy's read timeout ends the body short (a truncated
                // chunk, an HTTP/2 reset), and so does a network gone.
                End.CUT
            }
        }

        private fun report(problem: String) = onMain { listener.onProblem(this@EventStreamConnection, problem) }

        /** Runs [block] on the stream's thread while this is still its connection. */
        fun onMain(block: () -> Unit) = later.post(Runnable { if (!closed && isCurrent) block() }, 0)
    }

    /**
     * What follows a stream that ended without being refused: [failures] is
     * the count before it, [pings] how many pings it carried, [onTheWay]
     * whether its end can come from something on the way to the server (it
     * went live, then was closed, or cut while the device had a network),
     * [earlyCloses] how many such streams before it in a row ended before
     * their second ping. A stream that carried two pings worked, and starts
     * the failures again; any other end starts the early closes again.
     */
    data class Reconnect(val delayMs: Long, val failures: Int, val earlyCloses: Int, val floorPing: Boolean)

    companion object {
        /**
         * What the stream asks the server to ping at. Stalwart sends no ping more
         * often than every 30 s (crates/jmap/src/api/event_source.rs); a longer
         * interval lets the radio sleep between pings and is still shorter than
         * the idle timeout of most mobile networks.
         */
        const val PING_SECONDS = 120

        /**
         * Stalwart's floor (event_source.rs). Asked for once streams of the
         * account ended before their second ping [EARLY_CLOSES_FOR_FLOOR]
         * times in a row, closed, or cut while the device had a network:
         * something on the way (a proxy's read timeout, 60 s in nginx by
         * default) cuts quieter streams. One such end is a server restart, a
         * proxy reload or a network change. Left when the network changes or
         * the service starts again ([floorPing]), and asked for again if the
         * early ends come back.
         */
        const val PING_FLOOR_SECONDS = 30

        const val EARLY_CLOSES_FOR_FLOOR = 2

        /** A silent stream is given two pings and this before it is taken for dead. */
        const val PING_GRACE_MS = 30_000L

        private const val CONNECT_WAKE_LOCK_MS = 15_000L

        private val BACKOFF_MS = longArrayOf(2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000)

        fun backoff(failures: Int): Long = BACKOFF_MS[failures.coerceIn(0, BACKOFF_MS.size - 1)]

        fun reconnect(failures: Int, pings: Int, onTheWay: Boolean, earlyCloses: Int): Reconnect {
            val worked = pings >= 2
            val count = if (worked) 0 else failures
            val early = if (onTheWay && !worked) earlyCloses + 1 else 0
            return Reconnect(backoff(count), count + 1, early, floorPing = early >= EARLY_CLOSES_FOR_FLOOR)
        }

        /**
         * [client] with an empty pool of its own, to connect through once the
         * network changed. A connection made on the old network can still
         * look healthy in a pool (an HTTP/2 connection outlives its cancelled
         * streams), and a stream sent down it would wait, unanswered, for the
         * watchdog.
         */
        fun onNewNetwork(client: OkHttpClient): OkHttpClient =
            client.newBuilder().connectionPool(ConnectionPool()).build()

        /** The session's `eventSourceUrl` template filled in (RFC 8620 §7.3). */
        fun streamUrl(template: String, types: List<String>, pingSeconds: Int): String =
            template
                .replace("{types}", types.joinToString(","))
                .replace("{closeafter}", "no")
                .replace("{ping}", pingSeconds.toString())

        private fun isEventStream(contentType: String?): Boolean =
            contentType?.substringBefore(';')?.trim()?.equals("text/event-stream", ignoreCase = true) == true

        /** The interval a `ping` event announces, in seconds, or null. */
        private fun pingInterval(data: String): Int? = try {
            JSONObject(data).optInt("interval", 0).takeIf { it > 0 }
        } catch (_: JSONException) {
            null
        }
    }
}
