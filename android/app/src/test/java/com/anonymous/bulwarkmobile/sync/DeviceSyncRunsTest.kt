package com.anonymous.bulwarkmobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceSyncRunsTest {
    private val contacts = "com.android.contacts"
    private val calendar = "com.android.calendar"

    @Test
    fun `a report is accepted once, while the adapter waits`() {
        val run = DeviceSyncRuns.open("alice", contacts)
        assertTrue(DeviceSyncRuns.finish(run.runId, "{\"outcome\":\"ok\"}"))
        assertFalse(DeviceSyncRuns.finish(run.runId, "{\"outcome\":\"io\"}"))
        assertFalse(run.end("no report before the deadline"))
        assertEquals(0L, run.done.count)
        assertEquals("{\"outcome\":\"ok\"}", run.report)
        assertEquals("reported", run.endReason)
        DeviceSyncRuns.close(run)
    }

    @Test
    fun `a report after the run ended is refused whole`() {
        val run = DeviceSyncRuns.open("alice", contacts)
        assertTrue(run.end("no report before the deadline"))
        assertFalse(DeviceSyncRuns.finish(run.runId, "{\"outcome\":\"ok\"}"))
        assertNull(run.report)
        assertEquals("no report before the deadline", run.endReason)
        DeviceSyncRuns.close(run)
        assertFalse(DeviceSyncRuns.finish(run.runId, "{\"outcome\":\"ok\"}"))
    }

    @Test
    fun `runs nobody waits for, or that ended, count as cancelled`() {
        assertTrue(DeviceSyncRuns.isCancelled("unknown"))
        val run = DeviceSyncRuns.open("alice", calendar)
        assertFalse(DeviceSyncRuns.isCancelled(run.runId))
        run.end("task finished")
        assertTrue(DeviceSyncRuns.isCancelled(run.runId))
        DeviceSyncRuns.close(run)
        assertTrue(DeviceSyncRuns.isCancelled(run.runId))
    }

    @Test
    fun `a sync requested during a run flags that run only, and the flag outlives the close`() {
        val mine = DeviceSyncRuns.open("alice", contacts)
        val otherAuthority = DeviceSyncRuns.open("alice", calendar)
        val otherAccount = DeviceSyncRuns.open("bob", contacts)
        assertTrue(DeviceSyncRuns.flagSyncAgain("alice", contacts))
        DeviceSyncRuns.close(mine)
        assertTrue(mine.syncAgainRequested)
        assertFalse(otherAuthority.syncAgainRequested)
        assertFalse(otherAccount.syncAgainRequested)
        // Closed runs are not flagged any more.
        assertFalse(DeviceSyncRuns.flagSyncAgain("alice", contacts))
        DeviceSyncRuns.close(otherAuthority)
        DeviceSyncRuns.close(otherAccount)
    }
}
