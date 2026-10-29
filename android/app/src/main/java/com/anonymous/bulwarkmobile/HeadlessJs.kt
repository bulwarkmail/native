package com.anonymous.bulwarkmobile

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.MainThread
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.interfaces.TaskInterface
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Running a headless JS task without HeadlessJsTaskService: starting React
 * Native when the process was woken without any UI, and starting the task on
 * its context. Shared by the push job (BulwarkPushJobService) and the device
 * sync adapters.
 */
object HeadlessJs {
    private const val TAG = "HeadlessJs"

    /** No caller waits longer for React Native: JobScheduler stops sync and push jobs after 10 minutes. */
    private const val MAX_WAIT_MS = 600_000L
    private const val WATCH_MS = 1_000L

    /**
     * Calls [onReady] once with a React context whose JS instance is up,
     * starting React Native if the process was woken for this work.
     *
     * A context exists before its instance is ready, and a task started on
     * it then never reaches JS (HeadlessJsTaskContext only logs "CatalystInstance
     * not available" and waits for the timeout), which happened when several
     * pushes arrived while the app was starting. So the listener goes in
     * first and the ready check after it; whichever sees the ready instance
     * first runs the task.
     *
     * The wait ends once, and its listener goes with it: with a ready context,
     * or without one when React fails to start (the start task faults) or
     * after [MAX_WAIT_MS], when no caller can still be waiting. A context that
     * comes up later runs nothing of it, so waits given up on don't pile up on
     * the host with everything their [onReady] holds. (A caller that gives up
     * sooner, like the sync adapter at its deadline, checks that in [onReady].)
     *
     * Call it on the main thread; [onReady] runs there too. MainApplication
     * creates the ReactHost on first use without a lock (ExpoReactHostFactory),
     * so a background caller racing MainActivity could create a second one,
     * with a second JS runtime.
     *
     * Returns React Native's start task when it had to be started, so a caller
     * can notice a start that fails (a debug build with no Metro to load the
     * bundle from), or null when the context was already up.
     */
    @MainThread
    fun withReadyReactContext(app: Application, onReady: (ReactContext) -> Unit): TaskInterface<Void>? {
        val reactApp = app as ReactApplication
        if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
            val host = checkNotNull(reactApp.reactHost) { "ReactHost is not initialized in New Architecture" }
            val wait = ContextWait(onReady) { host.removeReactInstanceEventListener(it) }
            host.addReactInstanceEventListener(wait)
            val current = host.currentReactContext
            if (current != null && current.hasActiveReactInstance()) {
                wait.onReactContextInitialized(current)
                return null
            }
            return host.start().also { wait.watch(it) }
        }
        @Suppress("DEPRECATION")
        val manager = reactApp.reactNativeHost.reactInstanceManager
        val wait = ContextWait(onReady) { manager.removeReactInstanceEventListener(it) }
        manager.addReactInstanceEventListener(wait)
        val current = manager.currentReactContext
        if (current != null && current.hasActiveReactInstance()) {
            wait.onReactContextInitialized(current)
            return null
        }
        if (!manager.hasStartedCreatingInitialContext()) manager.createReactContextInBackground()
        wait.watch(null)
        return null
    }

    /** One caller's wait for a ready context: a listener on the host that ends once and then removes itself. */
    private class ContextWait(
        private val onReady: (ReactContext) -> Unit,
        private val removeListener: (ReactInstanceEventListener) -> Unit,
    ) : ReactInstanceEventListener {
        private val ended = AtomicBoolean(false)

        override fun onReactContextInitialized(context: ReactContext) {
            if (end()) onReady(context)
        }

        /** Ends the wait without a context once [boot] faulted or [MAX_WAIT_MS] passed; checked on the main thread. */
        fun watch(boot: TaskInterface<Void>?) {
            val main = Handler(Looper.getMainLooper())
            val giveUpAt = SystemClock.elapsedRealtime() + MAX_WAIT_MS
            main.postDelayed(object : Runnable {
                override fun run() {
                    if (ended.get()) return
                    val faulted = boot?.isFaulted() == true
                    if (!faulted && SystemClock.elapsedRealtime() < giveUpAt) {
                        main.postDelayed(this, WATCH_MS)
                    } else if (end()) {
                        val why = if (faulted) "React Native did not start" else "no React context after $MAX_WAIT_MS ms"
                        Log.w(TAG, "$why; no longer waiting")
                    }
                }
            }, WATCH_MS)
        }

        private fun end(): Boolean {
            if (!ended.compareAndSet(false, true)) return false
            removeListener(this)
            return true
        }
    }

    /**
     * Starts [config] on the UI thread, where HeadlessJsTaskContext wants it.
     * [onStarted] gets the task id in that same UI-thread turn, so before any
     * finish callback (HeadlessJsTaskContext posts those to the UI thread).
     * [onRefused] gets the refusal when the context is resumed and [config]
     * isn't allowed in the foreground.
     */
    fun startTask(
        tasks: HeadlessJsTaskContext,
        config: HeadlessJsTaskConfig,
        onStarted: (taskId: Int) -> Unit,
        onRefused: (IllegalStateException) -> Unit,
    ) {
        UiThreadUtil.runOnUiThread {
            val taskId = try {
                tasks.startTask(config)
            } catch (e: IllegalStateException) {
                onRefused(e)
                return@runOnUiThread
            }
            onStarted(taskId)
        }
    }
}
