package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.unifiedpush.android.connector.UnifiedPush

// JS-facing surface for UnifiedPush distributor management. Events from the
// distributor (endpoint changes, incoming messages) arrive through
// BulwarkUnifiedPushService, which emits them on the shared device-event
// channel.
class BulwarkUnifiedPushModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BulwarkUnifiedPush"

    @ReactMethod
    fun getDistributors(promise: Promise) {
        try {
            val array = Arguments.createArray()
            for (d in UnifiedPush.getDistributors(reactApplicationContext)) array.pushString(d)
            promise.resolve(array)
        } catch (err: Exception) {
            promise.reject("up_distributors_failed", err)
        }
    }

    @ReactMethod
    fun getSavedDistributor(promise: Promise) {
        try {
            promise.resolve(UnifiedPush.getSavedDistributor(reactApplicationContext))
        } catch (err: Exception) {
            promise.reject("up_distributor_failed", err)
        }
    }

    @ReactMethod
    fun getAckDistributor(promise: Promise) {
        try {
            promise.resolve(UnifiedPush.getAckDistributor(reactApplicationContext))
        } catch (err: Exception) {
            promise.reject("up_distributor_failed", err)
        }
    }

    @ReactMethod
    fun saveDistributor(distributor: String, promise: Promise) {
        try {
            UnifiedPush.saveDistributor(reactApplicationContext, distributor)
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("up_save_distributor_failed", err)
        }
    }

    // Asks the saved distributor for an endpoint. The endpoint itself arrives
    // asynchronously via BulwarkUnifiedPushService.onNewEndpoint (event
    // `up:newEndpoint`); failures via `up:registrationFailed`. `vapid` is the
    // relay's VAPID public key - optional, some distributors use it to
    // restrict who may push.
    @ReactMethod
    fun register(vapid: String?, promise: Promise) {
        try {
            UnifiedPush.register(
                reactApplicationContext,
                messageForDistributor = null,
                vapid = vapid?.takeIf { it.isNotBlank() },
            )
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("up_register_failed", err)
        }
    }

    @ReactMethod
    fun unregister(promise: Promise) {
        try {
            UnifiedPush.unregister(reactApplicationContext)
            BulwarkUnifiedPushService.clearEndpoint(reactApplicationContext)
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("up_unregister_failed", err)
        }
    }

    @ReactMethod
    fun getEndpoint(promise: Promise) {
        val stored = BulwarkUnifiedPushService.readEndpoint(reactApplicationContext)
        if (stored == null) {
            promise.resolve(null)
            return
        }
        val (url, p256dh, auth) = stored
        val map = Arguments.createMap().apply {
            putString("url", url)
            putString("p256dh", p256dh)
            putString("auth", auth)
        }
        promise.resolve(map)
    }

    // NativeEventEmitter required no-ops.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
