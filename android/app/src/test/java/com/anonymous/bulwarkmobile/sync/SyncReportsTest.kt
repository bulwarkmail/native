package com.anonymous.bulwarkmobile.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class SyncReportsTest {
    private fun report(outcome: String, extra: String = "") = """
        {"v":1,"runId":"r","authority":"com.android.contacts","outcome":"$outcome",
         "startedAt":0,"durationMs":5,"conflicts":0,"itemErrors":[],
         "stats":{"downloaded":{"created":3,"updated":2,"deleted":1},
                  "uploaded":{"created":1,"updated":4,"deleted":2},"entries":13,"skipped":1}$extra}
    """.trimIndent()

    @Test
    fun `a run without a report is a soft error`() {
        assertEquals(SyncOutcome(ioErrors = 1), SyncReports.outcome(null, "task finished"))
    }

    @Test
    fun `an unreadable report is a soft error`() {
        assertEquals(SyncOutcome(ioErrors = 1), SyncReports.outcome("{not json", "reported"))
    }

    @Test
    fun `ok sums both directions into the framework's stats`() {
        assertEquals(
            SyncOutcome(inserts = 4, updates = 6, deletes = 3, entries = 13, skipped = 1),
            SyncReports.outcome(report("ok"), "reported"),
        )
    }

    @Test
    fun `io keeps the progress so the framework retries at once`() {
        val outcome = SyncReports.outcome(report("io"), "reported")
        assertEquals(1L, outcome.ioErrors)
        assertEquals(4L, outcome.inserts)
    }

    @Test
    fun `auth is hard and reports no progress, or the framework would retry it at once`() {
        assertEquals(
            SyncOutcome(authErrors = 1, entries = 13, skipped = 1),
            SyncReports.outcome(report("auth"), "reported"),
        )
    }

    @Test
    fun `permission, unsupported and safety aborts are database errors without progress`() {
        for (outcome in listOf("permission", "unsupported", "safetyAbort")) {
            assertEquals(
                outcome,
                SyncOutcome(databaseError = true, entries = 13, skipped = 1),
                SyncReports.outcome(report(outcome), "reported"),
            )
        }
    }

    @Test
    fun `too many deletions reports the pending deletions for the system notification`() {
        assertEquals(
            SyncOutcome(tooManyDeletions = true, deletes = 42, entries = 13, skipped = 1),
            SyncReports.outcome(report("tooManyDeletions", ""","tooManyDeletions":{"count":42,"threshold":20}"""), "reported"),
        )
    }

    @Test
    fun `delayUntil and moreRecordsToGet reach the framework`() {
        val outcome = SyncReports.outcome(report("ok", ""","delayUntil":1790000000,"moreRecordsToGet":true"""), "reported")
        assertEquals(1790000000L, outcome.delayUntil)
        assertEquals(true, outcome.fullSyncRequested)
    }

    @Test
    fun `cancelled and disabled runs are not errors`() {
        for (outcome in listOf("cancelled", "disabled")) {
            assertEquals(0L, SyncReports.outcome(report(outcome), "reported").ioErrors)
        }
    }

    @Test
    fun `an outcome this build does not know is retried`() {
        assertEquals(1L, SyncReports.outcome(report("somethingNew"), "reported").ioErrors)
    }

    @Test
    fun `the log summary names the outcome, failed items and the message`() {
        assertEquals("outcome=ok", SyncReports.summary(report("ok")))
        assertEquals(
            "outcome=internal message=Invalid column x",
            SyncReports.summary(report("internal", ",\"message\":\"Invalid column x\"")),
        )
        val withItems = report("ok").replace("\"itemErrors\":[]", "\"itemErrors\":[{\"ref\":\"a\"},{\"ref\":\"b\"}]")
        assertEquals("outcome=ok itemErrors=2", SyncReports.summary(withItems))
        assertEquals("no report", SyncReports.summary(null))
        assertEquals("unreadable report", SyncReports.summary("{"))
        val long = SyncReports.summary(report("io", ",\"message\":\"" + "m".repeat(400) + "\""))
        assertEquals("outcome=io message=".length + 300, long.length)
    }
}
