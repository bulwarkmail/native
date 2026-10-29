package com.anonymous.bulwarkmobile.sync

import android.content.SyncResult
import org.json.JSONException
import org.json.JSONObject

/**
 * What a run's report (src/device-sync/types.ts `RunReport`) asks of the
 * framework's SyncResult. Kept free of Android classes so JVM tests cover it;
 * [SyncReports.apply] copies it onto the real SyncResult.
 *
 * SyncManager treats io errors as soft (retry with back-off), auth errors,
 * database errors and too many deletions as hard (no retry until something
 * changes), and `fullSyncRequested` as "schedule another sync now".
 */
data class SyncOutcome(
    val ioErrors: Long = 0,
    val authErrors: Long = 0,
    val databaseError: Boolean = false,
    val tooManyDeletions: Boolean = false,
    val inserts: Long = 0,
    val updates: Long = 0,
    val deletes: Long = 0,
    val entries: Long = 0,
    val skipped: Long = 0,
    /** Epoch seconds; 0 when unset. */
    val delayUntil: Long = 0,
    val fullSyncRequested: Boolean = false,
)

object SyncReports {
    /**
     * Translates a report. [reportJson] is null when the run ended without
     * one ([endReason] says why: JS never answered, React failed to start, …),
     * which is a soft error so the framework retries.
     */
    fun outcome(reportJson: String?, endReason: String?): SyncOutcome {
        if (reportJson == null) return SyncOutcome(ioErrors = 1)
        val report = try {
            JSONObject(reportJson)
        } catch (e: JSONException) {
            return SyncOutcome(ioErrors = 1)
        }
        val stats = report.optJSONObject("stats")
        val down = stats?.optJSONObject("downloaded")
        val up = stats?.optJSONObject("uploaded")
        fun count(side: JSONObject?, key: String) = side?.optLong(key, 0) ?: 0
        val base = SyncOutcome(
            inserts = count(down, "created") + count(up, "created"),
            updates = count(down, "updated") + count(up, "updated"),
            deletes = count(down, "deleted") + count(up, "deleted"),
            entries = stats?.optLong("entries", 0) ?: 0,
            skipped = stats?.optLong("skipped", 0) ?: 0,
            delayUntil = report.optLong("delayUntil", 0),
            fullSyncRequested = report.optBoolean("moreRecordsToGet", false),
        )
        // SyncManager retries a failed sync at once, without back-off, when it
        // made progress (inserts, updates, or deletes without
        // tooManyDeletions). A hard error must therefore report none, or an
        // auth failure after some work would loop.
        val hard = base.copy(inserts = 0, updates = 0, deletes = 0)
        return when (report.optString("outcome")) {
            "ok", "cancelled", "disabled" -> base
            "auth" -> hard.copy(authErrors = 1)
            "permission", "unsupported", "safetyAbort" -> hard.copy(databaseError = true)
            "tooManyDeletions" -> hard.copy(
                tooManyDeletions = true,
                // Shown in the system's "too many deletions" notification.
                deletes = report.optJSONObject("tooManyDeletions")?.optLong("count", 0) ?: 0,
            )
            // "io", "internal" and anything a newer JS might send: retry, at
            // once if some work got done, else with back-off.
            else -> base.copy(ioErrors = 1)
        }
    }

    /**
     * One line for logcat: the report's outcome, its message and how many
     * items failed. The reason a run failed is otherwise only in the report,
     * and JS warnings from a headless run don't reach logcat.
     */
    fun summary(reportJson: String?): String {
        if (reportJson == null) return "no report"
        val report = try {
            JSONObject(reportJson)
        } catch (e: JSONException) {
            return "unreadable report"
        }
        val parts = mutableListOf("outcome=" + report.optString("outcome", "?"))
        val items = report.optJSONArray("itemErrors")?.length() ?: 0
        if (items > 0) parts += "itemErrors=$items"
        val message = report.optString("message", "")
        if (message.isNotEmpty()) parts += "message=" + message.take(MAX_LOGGED_MESSAGE)
        return parts.joinToString(" ")
    }

    private const val MAX_LOGGED_MESSAGE = 300

    fun apply(outcome: SyncOutcome, result: SyncResult) {
        result.stats.numIoExceptions += outcome.ioErrors
        result.stats.numAuthExceptions += outcome.authErrors
        result.stats.numInserts += outcome.inserts
        result.stats.numUpdates += outcome.updates
        result.stats.numDeletes += outcome.deletes
        result.stats.numEntries += outcome.entries
        result.stats.numSkippedEntries += outcome.skipped
        if (outcome.databaseError) result.databaseError = true
        if (outcome.tooManyDeletions) result.tooManyDeletions = true
        if (outcome.delayUntil > 0) result.delayUntil = outcome.delayUntil
        if (outcome.fullSyncRequested) result.fullSyncRequested = true
    }
}
