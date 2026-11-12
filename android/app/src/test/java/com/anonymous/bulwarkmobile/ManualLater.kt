package com.anonymous.bulwarkmobile

/** A [Later] on a clock the test moves: nothing runs until [advance]. Its [now] is the clock of the code under test. */
class ManualLater : Later {
    var now = 0L
        private set

    private val queue = mutableListOf<Pair<Long, Runnable>>()

    override fun post(runnable: Runnable, delayMs: Long) {
        queue += (now + delayMs) to runnable
    }

    override fun cancel(runnable: Runnable) {
        queue.removeAll { it.second === runnable }
    }

    /** How long from now each waiting runnable is due, in posting order. */
    fun delays(): List<Long> = queue.map { it.first - now }

    /** Moves the clock by [ms], running everything that falls due on the way, in time order. */
    fun advance(ms: Long) {
        val end = now + ms
        while (true) {
            val next = queue.filter { it.first <= end }.minByOrNull { it.first } ?: break
            queue.remove(next)
            now = next.first
            next.second.run()
        }
        now = end
    }
}
