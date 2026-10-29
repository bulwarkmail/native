package com.anonymous.bulwarkmobile.sync

import com.facebook.react.interfaces.TaskInterface
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The device sync runs an adapter is waiting for, keyed by a random run id.
 *
 * A run ends exactly once, on the first of: JS calling finishRun, the
 * headless task ending (JS settled, timed out or was reloaded away), React
 * refusing or failing to start, the adapter's deadline, or a cancel. A report
 * that arrives after that is refused whole rather than half-applied. Headless
 * task ids restart at 1 with every React context, so they never identify a
 * run; the run id does.
 */
object DeviceSyncRuns {
    const val NO_TASK = -1

    enum class State { WAITING, ENDED }

    class Run(val runId: String, val accountName: String, val authority: String) {
        private val state = AtomicReference(State.WAITING)
        private val syncAgain = AtomicBoolean(false)
        val done = CountDownLatch(1)

        /** Written before [done] opens, read after it: the latch orders them. */
        @Volatile var report: String? = null
            private set
        @Volatile var endReason: String? = null
            private set
        @Volatile var cancelled = false
        @Volatile var boot: TaskInterface<Void>? = null
        /** Written and compared on the UI thread only. */
        @Volatile var taskId = NO_TASK
        @Volatile private var tasks: HeadlessJsTaskContext? = null
        @Volatile private var listener: HeadlessJsTaskEventListener? = null

        val isWaiting: Boolean get() = state.get() == State.WAITING

        /** True once a sync was requested for this account and authority while the run was open. */
        val syncAgainRequested: Boolean get() = syncAgain.get()

        /** Releases the waiting adapter. Only the first end counts; returns whether this was it. */
        fun end(reason: String): Boolean = end(reason, null)

        internal fun end(reason: String, reportJson: String?): Boolean {
            if (!state.compareAndSet(State.WAITING, State.ENDED)) return false
            report = reportJson
            endReason = reason
            done.countDown()
            return true
        }

        internal fun requestSyncAgain() {
            syncAgain.set(true)
        }

        fun attach(tasks: HeadlessJsTaskContext, listener: HeadlessJsTaskEventListener) {
            this.tasks = tasks
            this.listener = listener
            tasks.addTaskEventListener(listener)
        }

        fun detach() {
            val tasks = tasks ?: return
            listener?.let { tasks.removeTaskEventListener(it) }
            this.tasks = null
            this.listener = null
        }
    }

    private val runs = ConcurrentHashMap<String, Run>()

    fun open(accountName: String, authority: String): Run =
        Run(UUID.randomUUID().toString(), accountName, authority).also { runs[it.runId] = it }

    /**
     * Forgets the run: a late finishRun is then refused and isCancelled
     * answers true. Read [Run.syncAgainRequested] after this, so a request
     * can no longer slip in between reading the flag and closing.
     */
    fun close(run: Run) {
        run.end("closed")
        run.cancelled = true
        runs.remove(run.runId)
    }

    /** From JS. Accepted only while the adapter still waits for this run: false when it ended, timed out or is unknown. */
    fun finish(runId: String, reportJson: String): Boolean =
        runs[runId]?.end("reported", reportJson) ?: false

    /** Runs nobody waits for, or that already ended, count as cancelled: JS should stop. */
    fun isCancelled(runId: String): Boolean {
        val run = runs[runId] ?: return true
        return run.cancelled || !run.isWaiting
    }

    fun cancel(runId: String) {
        runs[runId]?.cancelled = true
    }

    /**
     * Flags the open runs of [accountName] and [authority] to request another
     * sync when they end (`SyncResult.fullSyncRequested`): SyncManager drops a
     * `requestSync` that matches a sync it is running, so a change pushed
     * mid-run would otherwise wait for the next trigger. Returns whether a
     * run was flagged.
     */
    fun flagSyncAgain(accountName: String, authority: String): Boolean {
        var flagged = false
        for (run in runs.values) {
            if (run.accountName == accountName && run.authority == authority) {
                run.requestSyncAgain()
                flagged = true
            }
        }
        return flagged
    }
}
