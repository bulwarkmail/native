package com.anonymous.bulwarkmobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.uimanager.ViewManager

class BulwarkFcmPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        buildList {
            add(BulwarkFcmModule(reactContext))
            add(BulwarkUnifiedPushModule(reactContext))
            add(BulwarkClientCertModule(reactContext))
            // The bridge registers React Native's own module under this name.
            if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
                add(BulwarkHeadlessJsTaskSupportModule(reactContext))
            }
        }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
