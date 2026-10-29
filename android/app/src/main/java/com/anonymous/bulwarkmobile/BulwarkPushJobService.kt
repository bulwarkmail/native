package com.anonymous.bulwarkmobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.concurrent.ConcurrentHashMap

/**
 * Runs the BulwarkPushTask headless JS task from a JobScheduler job.
 *
 * A push normally starts BulwarkPushTaskService, but Android 8+ only lets a
 * background app start a service while it is temporarily allowlisted, which a
 * high-priority FCM message does. FCM delivers some messages at normal
 * priority anyway (it downgrades apps whose high-priority pushes rarely end in
 * a notification), and a UnifiedPush distributor may not raise the app at all.
 * The service start then throws, so the push is handed to this job instead:
 * expedited on Android 12+, where it runs right away while the app has
 * expedited-job quota and as a regular job after that, and a regular job on
 * Android 8-11. It needs no new dependency and ends in the same notification
 * as the service path.
 */
class BulwarkPushJobService : JobService(), HeadlessJsTaskEventListener {
    private class RunningTask(val params: JobParameters, val startedAt: Long)

    private val running = ConcurrentHashMap<Int, RunningTask>()
    private var taskContext: HeadlessJsTaskContext? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val config = BulwarkPushTaskService.taskConfig(Bundle(params.extras))
        // JobService callbacks run on the main thread, where HeadlessJs wants to be called.
        HeadlessJs.withReadyReactContext(application) { startTask(it, config, params) }
        return true
    }

    // The JS task has its own 30 s timeout and finishes on its own; nothing to
    // reschedule if the system stops the job first.
    override fun onStopJob(params: JobParameters): Boolean {
        running.values.removeIf { it.params.jobId == params.jobId }
        return false
    }

    override fun onDestroy() {
        taskContext?.removeTaskEventListener(this)
        super.onDestroy()
    }

    override fun onHeadlessJsTaskStart(taskId: Int) = Unit

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        val task = running.remove(taskId) ?: return
        val ms = SystemClock.elapsedRealtime() - task.startedAt
        Log.i(TAG, "Push task $taskId from job ${task.params.jobId} finished after $ms ms")
        jobFinished(task.params, false)
    }

    private fun startTask(context: ReactContext, config: HeadlessJsTaskConfig, params: JobParameters) {
        val tasks = HeadlessJsTaskContext.getInstance(context)
        if (taskContext !== tasks) {
            taskContext?.removeTaskEventListener(this)
            tasks.addTaskEventListener(this)
            taskContext = tasks
        }
        HeadlessJs.startTask(
            tasks,
            config,
            onStarted = { taskId -> running[taskId] = RunningTask(params, SystemClock.elapsedRealtime()) },
            onRefused = { e ->
                // The app came to the foreground since the push arrived and
                // syncs on its own there.
                Log.i(TAG, "Push job ${params.jobId} skipped: ${e.message}")
                jobFinished(params, false)
            },
        )
    }

    companion object {
        private const val TAG = "BulwarkPush"

        // A block of job ids for push jobs, one per push that is waiting or
        // running. A pending job with the same id would be replaced (and a
        // running one stopped), so each push takes a free id.
        private const val JOB_ID_BASE = 0x42554c00
        private const val JOB_ID_COUNT = 32

        /** Schedules the push task as a job. Returns false if no job could be scheduled. */
        fun schedule(context: Context, data: Map<String, String>): Boolean = try {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            val busy = scheduler.allPendingJobs.mapTo(HashSet()) { it.id }
            val jobId = (JOB_ID_BASE until JOB_ID_BASE + JOB_ID_COUNT).firstOrNull { it !in busy }
            if (jobId == null) {
                // Every slot holds a push that has not finished yet; any of
                // them fetches the same new mail.
                Log.w(TAG, "Push not scheduled: $JOB_ID_COUNT push jobs already pending")
                false
            } else {
                val extras = PersistableBundle().apply {
                    for ((key, value) in data) putString(key, value)
                }
                val job = JobInfo.Builder(jobId, ComponentName(context, BulwarkPushJobService::class.java))
                    .setExtras(extras)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setExpedited(true) }
                    .build()
                val scheduled = scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
                Log.i(TAG, "Push job $jobId scheduled: $scheduled")
                scheduled
            }
        } catch (e: Exception) {
            Log.w(TAG, "Push job could not be scheduled", e)
            false
        }
    }
}
