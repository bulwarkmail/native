package com.anonymous.bulwarkmobile

/** One login's stream, as JavaScript describes it. */
data class DirectPushAccount(
    val id: String,
    val eventSourceUrl: String,
    val authorization: String,
    val types: List<String>,
    val label: String,
) {
    // Holds a credential and the user's address: never in a log.
    override fun toString(): String = "DirectPushAccount"
}

/**
 * Asking JavaScript for the accounts' stream credentials, which the direct
 * connection never reads from the secure store itself: at most one request
 * at a time, each numbered so a late answer is dropped, with back-off after
 * a failed one, and refusals counted so an account whose server keeps
 * refusing them is given up on until the next start. Main thread only.
 */
class DirectPushCredentials(
    private val later: Later,
    private val clock: () -> Long,
    private val task: Task,
    private val listener: Listener,
    /** Numbers the requests; process-wide, so a stopped instance's late answer never matches the next one's request. */
    private val nextRequest: () -> Int = ::nextProcessRequest,
) {
    /** The headless task that answers through BulwarkDirectPushModule. */
    interface Task {
        /** Starts the task for [request]; [ended] runs on the main thread once it ended, answered or not. */
        fun start(request: Int, ended: () -> Unit)

        /** The request ended: what [start] holds for it (a wake lock) can go. */
        fun stop()
    }

    interface Listener {
        /** The streams to keep: those of [accounts], and those of the [unreadable] accounts as they are. */
        fun apply(accounts: List<DirectPushAccount>, unreadable: Set<String>, refused: Set<String>)

        /** An account was refused [refusals] times in a row and is no longer asked for. */
        fun onGivenUp(refusals: Int)

        /** When the next request is due ([retryAt]) changed. */
        fun onDueChanged()
    }

    /**
     * JavaScript's answer to request [request]; [unreadable] are the accounts
     * whose credentials could not be read, [refused] those whose server
     * refused them.
     */
    data class Answer(
        val request: Int,
        val accounts: List<DirectPushAccount>,
        val unreadable: Set<String>,
        val refused: Set<String>,
    ) {
        // The ids are the users' addresses: never in a log.
        override fun toString(): String =
            "Answer(request=$request, accounts=${accounts.size}, unreadable=${unreadable.size}, refused=${refused.size})"
    }

    private var pending = false
    // Started again while a request was pending: its answer is out of date.
    private var stale = false
    private var answered = false
    private var failures = 0
    private var dueAt = 0L
    private var request = 0
    private var timeout: Runnable? = null
    private val retry = Runnable {
        retryAt = null
        ask()
    }

    /**
     * When the next request is due, on [clock], or null when none waits. Its
     * runnable waits on [later], which does not run while the device sleeps,
     * so the watchdog's [check] makes it once this time has come.
     */
    var retryAt: Long? = null
        private set

    // Refusals in a row per account, and the accounts no longer asked for
    // until JavaScript starts the service again.
    private val refusals = HashMap<String, Int>()
    private val givenUp = HashSet<String>()

    /** Neither waiting for an answer nor for the next request. */
    val isIdle: Boolean get() = !pending && retryAt == null

    /**
     * Started by JavaScript (an account was added or removed, the app
     * launched), after boot, or again by the system: ask now, whatever the
     * back-off, also for accounts given up on. A request already pending read
     * the accounts before the change; a new one follows.
     */
    fun restart() {
        refusals.clear()
        givenUp.clear()
        dueAt = 0L
        answered = false
        if (pending) stale = true else ask()
    }

    /** The watchdog's turn: asks unless an answer came since the last start, or when the next request is due ([retryAt]). */
    fun check() {
        val due = retryAt
        if (!answered || (due != null && clock() >= due)) ask()
    }

    /** The network is back: a request waiting for its turn is made now. */
    fun retryNow() {
        if (retryAt != null) askAgainNow()
    }

    fun answer(answer: Answer) {
        if (!pending || answer.request != request) return
        endRequest()
        if (stale) {
            askAgainNow()
            return
        }
        answered = true
        val retryMs = count(answer.refused)
        listener.apply(answer.accounts.filter { it.id !in givenUp }, answer.unreadable, answer.refused)
        if (answer.unreadable.isNotEmpty()) failures++ else failures = 0
        val delay = listOfNotNull(retryMs, if (answer.unreadable.isNotEmpty()) backoff(failures) else null).maxOrNull()
        if (delay != null) {
            dueAt = maxOf(dueAt, clock() + delay)
            schedule(delay)
        } else {
            cancelRetry()
        }
    }

    /**
     * [id]'s stream was refused: its credentials are stale (a token expired,
     * a password changed), so they are asked for again, a few times in a row
     * at most.
     */
    fun refused(id: String) {
        val delay = count(setOf(id)) ?: return
        dueAt = maxOf(dueAt, clock() + delay)
        ask()
    }

    /** [id]'s stream carried an event: its credentials work. */
    fun working(id: String) {
        refusals.remove(id)
    }

    fun close() {
        cancelRetry()
        if (pending) endRequest()
    }

    private fun ask() {
        if (pending) return
        val now = clock()
        if (now < dueAt) {
            schedule(dueAt - now)
            return
        }
        cancelRetry()
        pending = true
        dueAt = now + backoff(failures)
        request = nextRequest()
        val current = request
        // A React Native that never comes up ends the attempt without a word.
        val end = Runnable { ended(current) }
        timeout = end
        later.post(end, ANSWER_TIMEOUT_MS)
        task.start(current) { ended(current) }
    }

    /** Request [ended] is over; without an answer through the module it failed, so ask again later. */
    private fun ended(ended: Int) {
        if (!pending || ended != request) return
        endRequest()
        if (stale) {
            askAgainNow()
            return
        }
        failures++
        schedule(backoff(failures))
    }

    private fun askAgainNow() {
        stale = false
        dueAt = 0L
        ask()
    }

    private fun endRequest() {
        pending = false
        timeout?.let(later::cancel)
        timeout = null
        task.stop()
    }

    private fun schedule(delayMs: Long) {
        later.cancel(retry)
        later.post(retry, delayMs)
        retryAt = clock() + delayMs
        listener.onDueChanged()
    }

    private fun cancelRetry() {
        later.cancel(retry)
        retryAt = null
    }

    /** Counts [refused] in a row per account; returns the wait before asking again, null when all are given up on. */
    private fun count(refused: Set<String>): Long? {
        var retryMs: Long? = null
        for (id in refused) {
            val count = (refusals[id] ?: 0) + 1
            refusals[id] = count
            if (count >= MAX_REFUSALS) {
                if (givenUp.add(id)) listener.onGivenUp(count)
            } else {
                retryMs = maxOf(retryMs ?: 0L, backoff(count))
            }
        }
        return retryMs
    }

    companion object {
        /**
         * Refusals in a row after which an account's credentials are no longer
         * asked for: 401 and 403, and 404 and 410, an event source the server
         * no longer has (EventStreamConnection).
         */
        const val MAX_REFUSALS = 3

        /** The task's own timeout, once React Native runs it. */
        const val TASK_TIMEOUT_MS = 60_000L

        /**
         * When an attempt with no answer and no end is taken for failed and
         * asked again with back-off. React Native starts within seconds even
         * in a cold process, and the task then has its own minute; three
         * minutes leave room for a slow boot. HeadlessJs may still start the
         * task later: its answer is to a request no longer pending, and dropped.
         */
        const val ANSWER_TIMEOUT_MS = 180_000L

        private fun backoff(failures: Int) = EventStreamConnection.backoff(failures)

        // Main thread only, like every instance.
        private var lastRequest = 0

        private fun nextProcessRequest() = ++lastRequest
    }
}
