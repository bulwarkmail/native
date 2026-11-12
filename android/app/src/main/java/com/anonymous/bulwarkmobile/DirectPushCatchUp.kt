package com.anonymous.bulwarkmobile

/**
 * The server sends no `state` event when a stream opens, so mail delivered
 * while an account had no stream is only looked for when its stream goes
 * live: at once the first time, then at most every [SPACING_MS], so streams
 * that open again and again wake the push task at most once a minute and no
 * gap goes unchecked. Main thread only.
 */
class DirectPushCatchUp(
    private val later: Later,
    private val clock: () -> Long,
    /**
     * Wakes the push task for the account, which notifies only what it has
     * not notified before; false when the account no longer has a stream.
     */
    private val wake: (accountId: String) -> Boolean,
) {
    // Per account: the last wake, and the one waiting for its turn.
    private val wokeAt = HashMap<String, Long>()
    private val waiting = HashMap<String, Runnable>()

    /** [accountId]'s stream went live. */
    fun live(accountId: String) {
        if (accountId in waiting) return
        val now = clock()
        val last = wokeAt[accountId]
        val run = Runnable {
            waiting.remove(accountId)
            if (wake(accountId)) wokeAt[accountId] = clock()
        }
        waiting[accountId] = run
        later.post(run, if (last == null) 0 else maxOf(0, last + SPACING_MS - now))
    }

    fun close() {
        for (run in waiting.values) later.cancel(run)
        waiting.clear()
    }

    companion object {
        const val SPACING_MS = 60_000L
    }
}
