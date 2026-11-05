package com.anonymous.bulwarkmobile

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient

/**
 * One connection pool for every OkHttp client React Native builds (fetch,
 * XMLHttpRequest and the event stream on top of it), so the push path can
 * drop the connections the app kept from the foreground.
 *
 * React Native's client has no connect or read timeout. A connection that
 * died silently while the app was in the background (a mobile network's NAT
 * forgot it, the server closed it and the FIN never arrived) stays in the
 * pool, and the push task's first request was sent down it and waited until
 * the task's 30 s timeout: no request reached the server and no
 * notification appeared (#94). A fresh connection costs one TLS handshake.
 */
object HttpConnections {
    private val pool = ConnectionPool()

    /** Call before React Native creates its first network module. */
    fun install(context: Context) {
        val app = context.applicationContext
        OkHttpClientProvider.setOkHttpClientFactory(
            object : OkHttpClientFactory {
                override fun createNewNetworkModuleClient(): OkHttpClient =
                    OkHttpClientProvider.createClientBuilder(app)
                        .connectionPool(pool)
                        .build()
            },
        )
    }

    /** Closes every pooled connection no request is using. */
    fun dropIdle() {
        pool.evictAll()
    }
}
