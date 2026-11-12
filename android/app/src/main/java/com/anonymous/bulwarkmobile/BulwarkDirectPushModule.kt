package com.anonymous.bulwarkmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// JS-facing surface of the direct connection (BulwarkDirectPushService):
// turning it on and off, and handing it the accounts' stream credentials,
// which it keeps in memory only. The shapes are those of
// src/lib/direct-push.ts; anything else is rejected whole, so a partly read
// answer never closes a stream that works.
class BulwarkDirectPushModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BulwarkDirectPush"

    // `texts`: { channelName, title, text, stoppedText, problemChannelName },
    // the notifications in the app's language.
    @ReactMethod
    fun start(texts: ReadableMap, promise: Promise) {
        try {
            BulwarkDirectPushService.start(reactApplicationContext, readTexts(texts))
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("direct_push_start_failed", err)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            BulwarkDirectPushService.stop(reactApplicationContext)
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("direct_push_stop_failed", err)
        }
    }

    // The answer of the credentials task to the service's request:
    // { request, accounts: [{ id, eventSourceUrl, authorization, types, label }],
    //   unreadable, refused }. `unreadable` the ids of the accounts whose
    // credentials could not be read, `refused` those whose server refused them.
    @ReactMethod
    fun setAccounts(answer: ReadableMap, promise: Promise) {
        try {
            BulwarkDirectPushService.deliver(readAnswer(answer))
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("direct_push_accounts_failed", err)
        }
    }

    companion object {
        /** The request number: the credentials task's one argument, and carried back in its answer. */
        const val KEY_REQUEST = "request"
        private const val KEY_ACCOUNTS = "accounts"
        private const val KEY_UNREADABLE = "unreadable"
        private const val KEY_REFUSED = "refused"
        private const val KEY_ID = "id"
        private const val KEY_EVENT_SOURCE_URL = "eventSourceUrl"
        private const val KEY_AUTHORIZATION = "authorization"
        private const val KEY_TYPES = "types"
        private const val KEY_LABEL = "label"
        private const val KEY_CHANNEL_NAME = "channelName"
        private const val KEY_TITLE = "title"
        private const val KEY_TEXT = "text"
        private const val KEY_STOPPED_TEXT = "stoppedText"
        private const val KEY_PROBLEM_CHANNEL_NAME = "problemChannelName"

        /**
         * Throws IllegalArgumentException, naming the key but never a value, on
         * anything malformed. An account whose stream URL cannot be parsed is
         * refused rather than the answer: the others are served, and it is
         * asked for at most DirectPushCredentials.MAX_REFUSALS times.
         */
        fun readAnswer(map: ReadableMap): DirectPushCredentials.Answer {
            val request = map.number(KEY_REQUEST)
            require(request % 1.0 == 0.0 && request >= 0 && request <= Int.MAX_VALUE) { "$KEY_REQUEST is not a request number" }
            val accounts = map.array(KEY_ACCOUNTS)
            val (streamable, unparsable) = (0 until accounts.size()).map { i ->
                require(accounts.getType(i) == ReadableType.Map) { "$KEY_ACCOUNTS[$i] is not an object" }
                readAccount(accounts.getMap(i)!!)
            }.partition(::hasStreamUrl)
            return DirectPushCredentials.Answer(
                request = request.toInt(),
                accounts = streamable,
                unreadable = map.array(KEY_UNREADABLE).strings(KEY_UNREADABLE).toSet(),
                refused = map.array(KEY_REFUSED).strings(KEY_REFUSED).toSet() + unparsable.map { it.id },
            )
        }

        fun readTexts(map: ReadableMap) = DirectPushSettings.Texts(
            channel = map.string(KEY_CHANNEL_NAME),
            title = map.string(KEY_TITLE),
            text = map.string(KEY_TEXT),
            stoppedText = map.string(KEY_STOPPED_TEXT),
            problemChannel = map.string(KEY_PROBLEM_CHANNEL_NAME),
        )

        private fun readAccount(map: ReadableMap) = DirectPushAccount(
            id = map.string(KEY_ID),
            eventSourceUrl = map.string(KEY_EVENT_SOURCE_URL),
            authorization = map.string(KEY_AUTHORIZATION),
            types = map.array(KEY_TYPES).strings(KEY_TYPES),
            label = map.string(KEY_LABEL),
        )

        /** Whether [account]'s stream URL, filled in as the stream does, parses: OkHttp throws on one that does not. */
        private fun hasStreamUrl(account: DirectPushAccount): Boolean =
            EventStreamConnection.streamUrl(account.eventSourceUrl, account.types, EventStreamConnection.PING_SECONDS).toHttpUrlOrNull() != null

        private fun ReadableMap.typed(key: String, type: ReadableType) {
            require(hasKey(key) && getType(key) == type) { "$key is not a ${type.name.lowercase()}" }
        }

        private fun ReadableMap.string(key: String): String {
            typed(key, ReadableType.String)
            return getString(key)!!
        }

        private fun ReadableMap.number(key: String): Double {
            typed(key, ReadableType.Number)
            return getDouble(key)
        }

        private fun ReadableMap.array(key: String): ReadableArray {
            typed(key, ReadableType.Array)
            return getArray(key)!!
        }

        private fun ReadableArray.strings(key: String): List<String> = (0 until size()).map { i ->
            require(getType(i) == ReadableType.String) { "$key[$i] is not a string" }
            getString(i)!!
        }
    }
}
