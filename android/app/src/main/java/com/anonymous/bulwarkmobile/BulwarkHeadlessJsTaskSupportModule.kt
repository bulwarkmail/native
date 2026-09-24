package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * React Native's HeadlessJsTaskSupport module, which AppRegistry calls when a
 * headless JS task's promise settles. RN 0.81 registers it only for the old
 * bridge (CoreModulesPackage); the bridgeless runtime's CoreReactPackage
 * leaves it out, so in this app JS could never report a finished task and
 * every BulwarkPushTask ran until its 30 s timeout, keeping the service or job
 * and its wake lock alive that long. Same logic as the RN module.
 */
class BulwarkHeadlessJsTaskSupportModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "HeadlessJsTaskSupport"

    @ReactMethod
    fun notifyTaskFinished(taskId: Double) {
        val tasks = HeadlessJsTaskContext.getInstance(reactApplicationContext)
        val id = taskId.toInt()
        if (tasks.isTaskRunning(id)) tasks.finishTask(id)
    }

    @ReactMethod
    fun notifyTaskRetry(taskId: Double, promise: Promise) {
        val tasks = HeadlessJsTaskContext.getInstance(reactApplicationContext)
        val id = taskId.toInt()
        promise.resolve(tasks.isTaskRunning(id) && tasks.retryTask(id))
    }
}
