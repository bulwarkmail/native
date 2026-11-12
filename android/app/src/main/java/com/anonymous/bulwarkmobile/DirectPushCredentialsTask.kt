package com.anonymous.bulwarkmobile

import android.app.Application
import android.os.Handler
import android.os.PowerManager
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

/**
 * Runs `BulwarkDirectPushCredentialsTask` (src/lib/direct-push-task.ts,
 * registered in index.ts), which answers DirectPushCredentials through
 * BulwarkDirectPushModule, starting React Native first when the process was
 * woken without it. Holds the device awake until the request ends.
 */
class DirectPushCredentialsTask(private val app: Application, private val main: Handler) : DirectPushCredentials.Task {
    private val lock = app.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bulwark:direct-push-credentials")
        .apply { setReferenceCounted(false) }

    override fun start(request: Int, ended: () -> Unit) {
        lock.acquire(DirectPushCredentials.TASK_TIMEOUT_MS)
        val end = { main.post(ended) }
        HeadlessJs.withReadyReactContext(app) { context ->
            val tasks = HeadlessJsTaskContext.getInstance(context)
            val arguments = Arguments.createMap().apply { putInt(BulwarkDirectPushModule.KEY_REQUEST, request) }
            val config = HeadlessJsTaskConfig(NAME, arguments, DirectPushCredentials.TASK_TIMEOUT_MS, true)
            // Set in the UI-thread turn that starts the task, so before any
            // finish; other headless tasks (a push) finish on this context too.
            var startedId = -1
            val listener = object : HeadlessJsTaskEventListener {
                override fun onHeadlessJsTaskStart(taskId: Int) = Unit
                override fun onHeadlessJsTaskFinish(taskId: Int) {
                    if (taskId != startedId) return
                    tasks.removeTaskEventListener(this)
                    end()
                }
            }
            tasks.addTaskEventListener(listener)
            HeadlessJs.startTask(
                tasks,
                config,
                onStarted = { id ->
                    startedId = id
                    Log.i(TAG, "Direct push credentials task $id started")
                },
                onRefused = { e ->
                    Log.w(TAG, "Direct push credentials task refused: ${e.message}")
                    tasks.removeTaskEventListener(listener)
                    end()
                },
            )
        }
    }

    override fun stop() = lock.release()

    private companion object {
        const val TAG = "BulwarkDirectPush"
        /** The task's name, as index.ts registers it (DIRECT_PUSH_CREDENTIALS_TASK). */
        const val NAME = "BulwarkDirectPushCredentialsTask"
    }
}
