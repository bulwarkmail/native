package com.anonymous.bulwarkmobile

import android.os.Handler

/**
 * Delayed runnables on one thread: a [Handler] in the app, a fake with its
 * own clock in JVM tests, where android.os is only a stub. Lets the code that
 * waits and retries (the direct connection) be tested without a device.
 */
interface Later {
    fun post(runnable: Runnable, delayMs: Long)
    fun cancel(runnable: Runnable)
}

class HandlerLater(private val handler: Handler) : Later {
    override fun post(runnable: Runnable, delayMs: Long) {
        handler.postDelayed(runnable, delayMs)
    }

    override fun cancel(runnable: Runnable) = handler.removeCallbacks(runnable)
}
