package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * For JS to call after a list has moved under a still mouse pointer: the row
 * now under the pointer becomes the hovered one (MainActivity.rehover).
 */
class BulwarkPointerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "BulwarkPointer"

    @ReactMethod
    fun rehover() {
        UiThreadUtil.runOnUiThread { (reactApplicationContext.currentActivity as? MainActivity)?.rehover() }
    }
}
