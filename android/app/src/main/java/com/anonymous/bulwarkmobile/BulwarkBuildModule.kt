package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Facts about this build that JS can't see on its own. `distribution` is the
 * product flavor (app/build.gradle): "github" for the sideloaded APK with its
 * own updater, "play" for the Google Play bundle, which must not update
 * itself (lib/platform-capabilities).
 */
class BulwarkBuildModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "BulwarkBuild"

    override fun getConstants(): Map<String, Any> = mapOf(
        "distribution" to BuildConfig.DISTRIBUTION,
    )
}
