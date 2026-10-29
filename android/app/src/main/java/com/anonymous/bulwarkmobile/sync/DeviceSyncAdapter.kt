package com.anonymous.bulwarkmobile.sync

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Application
import android.app.Service
import android.content.AbstractThreadedSyncAdapter
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.SyncResult
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.MainThread
import com.anonymous.bulwarkmobile.HeadlessJs
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.concurrent.TimeUnit

/**
 * The sync adapter behind both authorities (#34). It does no syncing itself:
 * it starts the BulwarkDeviceSync headless JS task, where the engine lives
 * (src/device-sync), waits for its report and hands that to SyncManager. See
 * docs/device-sync.md.
 *
 * onPerformSync runs on its own SyncAdapterThread and may block; React Native
 * is started from the main thread (see HeadlessJs), which stays free.
 * SyncManager holds a wake lock for as long as onPerformSync runs.
 */
class DeviceSyncAdapter(context: Context) :
    AbstractThreadedSyncAdapter(context, /* autoInitialize = */ true, /* allowParallelSyncs = */ false) {

    private val main = Handler(Looper.getMainLooper())

    /**
     * Anything thrown out of here is rethrown on the sync thread
     * (AbstractThreadedSyncAdapter's SyncThread) and kills the process, the UI
     * included. So every failure becomes a result: a soft error SyncManager
     * retries with back-off, or a database error for a missing permission,
     * as the framework would report it.
     */
    override fun onPerformSync(
        account: Account,
        extras: Bundle,
        authority: String,
        provider: ContentProviderClient,
        syncResult: SyncResult,
    ) {
        try {
            performSync(account, extras, authority, syncResult)
        } catch (e: SecurityException) {
            Log.w(TAG, "Sync of $authority refused by a permission check", e)
            syncResult.databaseError = true
        } catch (t: Throwable) {
            Log.e(TAG, "Sync of $authority failed", t)
            syncResult.stats.numIoExceptions++
        }
    }

    private fun performSync(account: Account, extras: Bundle, authority: String, syncResult: SyncResult) {
        val registryId = AccountManager.get(context).getUserData(account, DeviceSyncAccounts.USER_DATA_REGISTRY_ID)
        if (registryId.isNullOrEmpty()) {
            Log.w(TAG, "Sync of $authority skipped: the account has no app account")
            syncResult.databaseError = true
            return
        }
        val startedAt = SystemClock.elapsedRealtime()
        // A sync scheduled as an expedited job (Android 12+) gets 3 minutes
        // from JobScheduler instead of 10; stay inside either.
        val expedited = extras.getBoolean(SYNC_EXTRAS_SCHEDULE_AS_EXPEDITED_JOB, false)
        val deadline = startedAt + if (expedited) EXPEDITED_BUDGET_MS else BUDGET_MS
        val run = DeviceSyncRuns.open(account.name, authority)
        main.post { startRun(run, account, registryId, authority, extras, deadline) }
        try {
            while (!run.done.await(POLL_MS, TimeUnit.MILLISECONDS)) {
                val boot = run.boot
                if (boot != null && boot.isFaulted()) {
                    run.end("React Native did not start: ${boot.getError()?.message}")
                } else if (SystemClock.elapsedRealtime() >= deadline) {
                    run.end("no report before the deadline")
                }
            }
            val outcome = SyncReports.outcome(run.report, run.endReason)
            SyncReports.apply(outcome, syncResult)
            Log.i(TAG, "Sync ${run.runId} of $authority ended (${run.endReason}) after " +
                "${SystemClock.elapsedRealtime() - startedAt} ms: ${SyncReports.summary(run.report)}; $outcome")
        } catch (e: InterruptedException) {
            // onSyncCanceled interrupts this thread. JS sees the run as
            // cancelled at its next checkpoint (isRunCancelled).
            run.end("cancelled")
            Log.i(TAG, "Sync ${run.runId} of $authority cancelled")
            Thread.currentThread().interrupt()
        } finally {
            DeviceSyncRuns.close(run)
            // After startRun, which was posted first, so a listener it added is removed.
            main.post { run.detach() }
        }
        // A change pushed while the run was open: SyncManager dropped its
        // request as a duplicate of this sync, so ask for the next one here.
        if (run.syncAgainRequested) {
            Log.i(TAG, "Sync ${run.runId} of $authority: changes arrived meanwhile, syncing again")
            syncResult.fullSyncRequested = true
        }
    }

    @MainThread
    private fun startRun(
        run: DeviceSyncRuns.Run,
        account: Account,
        registryId: String,
        authority: String,
        extras: Bundle,
        deadline: Long,
    ) {
        if (run.cancelled) return
        try {
            run.boot = HeadlessJs.withReadyReactContext(context.applicationContext as Application) { reactContext ->
                if (run.cancelled) return@withReadyReactContext
                if (!reactContext.hasActiveReactInstance()) {
                    run.end("the React Native instance is gone")
                    return@withReadyReactContext
                }
                val tasks = HeadlessJsTaskContext.getInstance(reactContext)
                run.attach(tasks, object : HeadlessJsTaskEventListener {
                    override fun onHeadlessJsTaskStart(taskId: Int) = Unit

                    // JS settled without a report, timed out, or the context was reloaded.
                    override fun onHeadlessJsTaskFinish(taskId: Int) {
                        if (taskId == run.taskId) run.end("task finished")
                    }
                })
                val taskTimeout = (deadline - SystemClock.elapsedRealtime() - LATCH_SLACK_MS).coerceAtLeast(MIN_TASK_MS)
                val data = Arguments.createMap().apply {
                    putString("runId", run.runId)
                    putString("accountName", account.name)
                    putString("registryId", registryId)
                    putString("authority", authority)
                    putMap("extras", runExtras(extras))
                    putDouble("deadline", (System.currentTimeMillis() + taskTimeout - JS_SLACK_MS).toDouble())
                }
                HeadlessJs.startTask(
                    tasks,
                    HeadlessJsTaskConfig(TASK_KEY, data, taskTimeout, /* isAllowedInForeground = */ true),
                    onStarted = { run.taskId = it },
                    onRefused = { run.end("refused: ${it.message}") },
                )
            }
        } catch (e: RuntimeException) {
            run.end("could not start: ${e.message}")
        }
    }

    private fun runExtras(extras: Bundle): WritableMap = Arguments.createMap().apply {
        fun flag(key: String, name: String) {
            if (extras.getBoolean(key, false)) putBoolean(name, true)
        }
        flag(ContentResolver.SYNC_EXTRAS_MANUAL, "manual")
        flag(ContentResolver.SYNC_EXTRAS_UPLOAD, "upload")
        flag(ContentResolver.SYNC_EXTRAS_EXPEDITED, "expedited")
        flag(ContentResolver.SYNC_EXTRAS_IGNORE_BACKOFF, "ignoreBackoff")
        flag(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS, "overrideTooManyDeletions")
        flag(ContentResolver.SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS, "discardLocalDeletions")
    }

    companion object {
        private const val TAG = "BulwarkDeviceSync"
        const val TASK_KEY = "BulwarkDeviceSync"

        /** ContentResolver.SYNC_EXTRAS_SCHEDULE_AS_EXPEDITED_JOB (API 31). */
        private const val SYNC_EXTRAS_SCHEDULE_AS_EXPEDITED_JOB = "schedule_as_expedited_job"

        private const val BUDGET_MS = 570_000L // 9.5 min of JobScheduler's 10
        private const val EXPEDITED_BUDGET_MS = 150_000L // 2.5 min of 3
        private const val LATCH_SLACK_MS = 20_000L // the task times out this long before our deadline
        private const val JS_SLACK_MS = 30_000L // JS aims to be done this long before the task timeout
        private const val MIN_TASK_MS = 30_000L
        private const val POLL_MS = 500L
    }
}

/** Binds the contacts authority's adapter (xml/sync_contacts.xml). */
class ContactsSyncService : Service() {
    override fun onBind(intent: Intent): IBinder = adapter(this).syncAdapterBinder

    companion object {
        @Volatile private var adapter: DeviceSyncAdapter? = null

        private fun adapter(context: Context): DeviceSyncAdapter = adapter ?: synchronized(this) {
            adapter ?: DeviceSyncAdapter(context.applicationContext).also { adapter = it }
        }
    }
}

/** Binds the calendar authority's adapter (xml/sync_calendar.xml). */
class CalendarSyncService : Service() {
    override fun onBind(intent: Intent): IBinder = adapter(this).syncAdapterBinder

    companion object {
        @Volatile private var adapter: DeviceSyncAdapter? = null

        private fun adapter(context: Context): DeviceSyncAdapter = adapter ?: synchronized(this) {
            adapter ?: DeviceSyncAdapter(context.applicationContext).also { adapter = it }
        }
    }
}
