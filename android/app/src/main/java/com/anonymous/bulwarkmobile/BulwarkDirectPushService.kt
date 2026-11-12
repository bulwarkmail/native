package com.anonymous.bulwarkmobile

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.anonymous.bulwarkmobile.sync.SyncProblemNotifier
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.network.CookieJarContainer
import com.facebook.react.modules.network.ForwardingCookieHandler
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.JavaNetCookieJar
import okhttp3.OkHttpClient
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * The direct connection: a third way, beside FCM and UnifiedPush, to learn of
 * new mail while the app is not on screen. This foreground service keeps the
 * JMAP event stream (EventStreamConnection) of every account with push open,
 * and a StateChange on it is handled exactly like a push from the relay. No
 * push subscription on the server, no relay, no distributor app.
 *
 * The service never reads the secure store. JavaScript hands it each
 * account's stream URL and Authorization value through BulwarkDirectPushModule
 * (DirectPushCredentials); they stay in memory. Every start asks for them
 * again, so a fresh process, a boot or a changed account list all go the same
 * way. The cost: each of those starts React Native in the background once.
 */
class BulwarkDirectPushService : Service(), DirectPushCredentials.Listener, EventStreamConnection.Listener {
    private val main = Handler(Looper.getMainLooper())
    private val later = HandlerLater(main)
    private lateinit var power: PowerManager
    private lateinit var client: OkHttpClient
    private lateinit var credentials: DirectPushCredentials
    // Where a push is handed on, one at a time and off the main thread, as
    // FCM's and UnifiedPush's services get theirs: the handing on drops idle
    // connections (HttpConnections.dropIdle), which writes to their sockets.
    private lateinit var pushes: ExecutorService
    // Touched on the main thread only.
    private val streams = HashMap<String, EventStreamConnection>()
    // Each account's number in the log, kept when its stream is replaced.
    private val streamSlots = HashMap<String, Int>()
    // The accounts on the floor ping (EventStreamConnection); left at a network change.
    private val floorPing = HashSet<String>()
    private var defaultRequests = 0
    private var defaultRequestsPerHost = 0
    private var network: Network? = null
    private var networkLost = false
    private val catchUp = DirectPushCatchUp(later, SystemClock::elapsedRealtime) { id ->
        val stream = streams[id] ?: return@DirectPushCatchUp false
        handOn(RelayPushData.catchUp(stream.account.label))
        true
    }

    private val offline: Boolean get() = network == null || networkLost

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(available: Network) {
            main.post {
                if (running !== this@BulwarkDirectPushService) return@post
                val reconnect = reconnects(network, networkLost, available)
                network = available
                networkLost = false
                val before = client
                if (reconnect) {
                    client = EventStreamConnection.onNewNetwork(client)
                    floorPing.clear()
                }
                for (stream in streams.values) {
                    if (reconnect) stream.reconnectNow() else stream.retryNow()
                }
                credentials.retryNow()
                // Closing a TLS connection writes to its socket: not on the main thread.
                if (reconnect) client.dispatcher.executorService.execute { before.connectionPool.evictAll() }
                scheduleWatchdog()
            }
        }

        override fun onLost(lost: Network) {
            main.post {
                if (running !== this@BulwarkDirectPushService || network != lost) return@post
                networkLost = true
                scheduleWatchdog()
            }
        }
    }

    private val watchdog = AlarmManager.OnAlarmListener { checkStreams() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        power = getSystemService(PowerManager::class.java)
        client = buildClient()
        defaultRequests = client.dispatcher.maxRequests
        defaultRequestsPerHost = client.dispatcher.maxRequestsPerHost
        pushes = Executors.newSingleThreadExecutor()
        credentials = DirectPushCredentials(later, SystemClock::elapsedRealtime, DirectPushCredentialsTask(application, main), this)
        running = this
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                } else {
                    0
                },
            )
        } catch (e: RuntimeException) {
            // Android refuses a foreground service started from the
            // background; the next app start or boot starts it again.
            Log.w(TAG, "Direct push not started: ${e.message}")
            stoppedItself()
            stopSelf()
            return START_NOT_STICKY
        }
        if (!DirectPushSettings.isEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Mail notifications could not be shown: streaming would only keep
        // the device awake for nothing.
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            Log.w(TAG, "Direct push: notifications are off, stopping")
            stoppedItself()
            stopSelf()
            return START_NOT_STICKY
        }
        SyncProblemNotifier.clear(this, STOPPED_NOTICE)
        credentials.restart()
        return START_STICKY
    }

    override fun onDestroy() {
        if (running === this) running = null
        credentials.close()
        catchUp.close()
        getSystemService(AlarmManager::class.java).cancel(watchdog)
        try {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        } catch (_: IllegalArgumentException) {
        }
        for (stream in streams.values) stream.close()
        streams.clear()
        // Pushes already handed over still start their task, and let the device sleep.
        pushes.shutdown()
        super.onDestroy()
    }

    /**
     * React Native's client, so proxies and certificates are the same, with
     * the system cookies the networking module gives its client: an
     * authenticating proxy in front of the server may need the cookie it set
     * on the app's requests. No read timeout: the watchdog judges a quiet
     * stream by its pings.
     */
    private fun buildClient(): OkHttpClient {
        val base = OkHttpClientProvider.createClient(applicationContext)
        (base.cookieJar as? CookieJarContainer)?.setCookieJar(JavaNetCookieJar(ForwardingCookieHandler()))
        return base.newBuilder()
            // Its own: streams never end and hold their slot (sized in apply).
            .dispatcher(Dispatcher())
            // Its own, replaced when the network changes (onNewNetwork).
            .connectionPool(ConnectionPool())
            .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    /** Opens, keeps or closes streams to match JavaScript's answer. */
    override fun apply(accounts: List<DirectPushAccount>, unreadable: Set<String>, refused: Set<String>) {
        val wanted = accounts.associateBy { it.id }
        for (id in streamsToClose(streams.keys, wanted.keys, unreadable)) streams.remove(id)?.close()
        for ((id, account) in wanted) {
            val current = streams[id]
            if (current?.account == account) continue
            current?.close()
            streams[id] = newStream(account).also { it.connect() }
        }
        // Room for every stream and for a replaced one still ending.
        client.dispatcher.maxRequestsPerHost = maxOf(defaultRequestsPerHost, streams.size * 2)
        client.dispatcher.maxRequests = maxOf(defaultRequests, streams.size * 2)
        Log.i(TAG, "Direct push: ${streams.size} stream(s), unreadable=${unreadable.size}, refused=${refused.size}")
    }

    override fun onGivenUp(refusals: Int) {
        Log.w(TAG, "Direct push: an account was refused $refusals times, no longer asking until the app starts it again")
    }

    private fun newStream(account: DirectPushAccount) = EventStreamConnection(
        account = account,
        name = streamName(streamSlots, account.id),
        client = { client },
        later = later,
        clock = SystemClock::elapsedRealtime,
        keepAwake = { timeoutMs -> keepAwake("bulwark:direct-push-connect", timeoutMs) },
        offline = { offline },
        floorPing = floorPing,
        listener = this,
    )

    /** JavaScript's answer to a credentials request; runs on the main thread. */
    private fun answered(answer: DirectPushCredentials.Answer) {
        credentials.answer(answer)
        stopIfIdle()
    }

    /**
     * Nothing to stream and nothing to ask for (every account given up on, a
     * client certificate, no event source): the permanent notification would
     * promise mail that never comes. The direct connection stays on, so the
     * next start (the app's launch, boot) asks again.
     */
    private fun stopIfIdle() {
        if (streams.isNotEmpty() || !credentials.isIdle) return
        Log.w(TAG, "Direct push: no account to stream, stopping")
        stoppedItself()
        stopSelf()
    }

    /**
     * The service stops itself while the mode is still on: new mail is no
     * longer notified and nothing else says so. One notification, posted the
     * way device sync posts its problems, tells the user and opens the app's
     * notification settings; the next run, or turning the mode off, clears it.
     */
    private fun stoppedItself() {
        if (!DirectPushSettings.isEnabled(this)) return
        val texts = DirectPushSettings.texts(this)
        SyncProblemNotifier.show(this, STOPPED_NOTICE, texts.channel, texts.stoppedText, SETTINGS_URI, texts.problemChannel)
    }

    override fun onLive(stream: EventStreamConnection) {
        Log.i(TAG, "Direct push ${stream.name} live")
        catchUp.live(stream.account.id)
    }

    override fun onWorking(stream: EventStreamConnection) = credentials.working(stream.account.id)

    override fun onState(stream: EventStreamConnection, data: String) {
        RelayPushData.ofStateChange(data, stream.account.label)?.let(::handOn)
    }

    override fun onRefused(stream: EventStreamConnection) {
        Log.i(TAG, "Direct push ${stream.name} refused, asking for credentials")
        stream.close()
        streams.remove(stream.account.id)
        credentials.refused(stream.account.id)
        stopIfIdle()
    }

    override fun onProblem(stream: EventStreamConnection, problem: String) {
        Log.i(TAG, "Direct push ${stream.name}: $problem")
    }

    override fun onDueChanged() = scheduleWatchdog()

    /**
     * Wakes the device now and then to look at the streams and the
     * credentials: a connection that died without a word (the network's NAT
     * forgot it) sends no ping and so wakes nothing, and a retry timer does
     * not run while the device sleeps. Set for the first moment a stream can
     * be found silent or due to retry, or a credentials request is due, so it
     * wakes once per silence window; inexact, so Android batches it with
     * other wake-ups. Without a network there is nothing to look at: its
     * return reconnects and asks.
     */
    private fun scheduleWatchdog() {
        val alarms = getSystemService(AlarmManager::class.java)
        if (offline) {
            alarms.cancel(watchdog)
            return
        }
        val now = SystemClock.elapsedRealtime()
        val due = (streams.values.mapNotNull { it.dueAt() } + listOfNotNull(credentials.retryAt)).minOrNull()
        alarms.set(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            due?.coerceAtLeast(now + WATCHDOG_MIN_MS) ?: (now + WATCHDOG_MS),
            "bulwark:direct-push-watchdog",
            watchdog,
            main,
        )
    }

    private fun checkStreams() {
        for (stream in streams.values.toList()) stream.check()
        credentials.check()
        scheduleWatchdog()
    }

    private fun notification(): Notification {
        val texts = DirectPushSettings.texts(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, texts.channel, NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(texts.title)
            .setContentText(texts.text)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .build()
    }

    /** A push read from a stream: what FCM and UnifiedPush do with theirs. Any thread. */
    private fun handOn(push: Map<String, String>) {
        val awake = keepAwake("bulwark:direct-push-event", HAND_ON_WAKE_LOCK_MS)
        try {
            pushes.execute {
                try {
                    BulwarkMessagingService.ensureChannel(applicationContext)
                    BulwarkMessagingService.handlePush(applicationContext, push)
                } finally {
                    awake.close()
                }
            }
        } catch (_: RejectedExecutionException) {
            // An event read while the service was being destroyed.
            awake.close()
        }
    }

    /** Holds the device awake for up to [timeoutMs], until the returned handle is closed. */
    private fun keepAwake(tag: String, timeoutMs: Long): AutoCloseable {
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag)
        lock.setReferenceCounted(false)
        lock.acquire(timeoutMs)
        return AutoCloseable { lock.release() }
    }

    companion object {
        private const val TAG = "BulwarkDirectPush"
        const val CHANNEL_ID = "bulwark_direct_push"
        private const val NOTIFICATION_ID = 0x42554c44
        private const val CONNECT_TIMEOUT_S = 30L
        private const val WATCHDOG_MS = EventStreamConnection.PING_SECONDS * 1000L + EventStreamConnection.PING_GRACE_MS
        private const val WATCHDOG_MIN_MS = 1_000L
        /**
         * How long a push may wait behind earlier ones on [pushes] and be
         * handed on. Handing on only starts the push task's service, which
         * keeps the device awake itself from there (BulwarkMessagingService
         * .startHeadlessTask); nothing here waits for React Native, so this
         * is far below DirectPushCredentials.ANSWER_TIMEOUT_MS.
         */
        private const val HAND_ON_WAKE_LOCK_MS = 60_000L
        // SyncProblemNotifier keys its notifications by name; this one's.
        private const val STOPPED_NOTICE = "direct-push"
        private const val SETTINGS_URI = "bulwarkmobile://settings/notifications"

        /** The running service; set and read on the main thread. */
        private var running: BulwarkDirectPushService? = null

        /**
         * Turns the direct connection on and starts the service, or makes the
         * running one ask for the accounts again; it stays on across reboots
         * and updates.
         */
        fun start(context: Context, texts: DirectPushSettings.Texts) {
            DirectPushSettings.enable(context, texts)
            launch(context)
        }

        /** Starts the service if the direct connection is on (boot, app update). */
        fun launch(context: Context) {
            if (!DirectPushSettings.isEnabled(context)) return
            ContextCompat.startForegroundService(context, Intent(context, BulwarkDirectPushService::class.java))
        }

        fun stop(context: Context) {
            DirectPushSettings.disable(context)
            SyncProblemNotifier.clear(context, STOPPED_NOTICE)
            context.stopService(Intent(context, BulwarkDirectPushService::class.java))
        }

        /** What the log calls [accountId]'s stream: never the account, which is the user's address. One number per account, given in [slots]. */
        fun streamName(slots: MutableMap<String, Int>, accountId: String): String =
            "stream ${slots.getOrPut(accountId) { slots.size + 1 }}"

        /**
         * The streams an answer closes: every one whose account it neither
         * gives ([wanted]) nor could not read ([unreadable]). A refused
         * account, or one gone, is in neither.
         */
        fun streamsToClose(current: Set<String>, wanted: Set<String>, unreadable: Set<String>): Set<String> =
            current - wanted - unreadable

        /**
         * Whether the network [available] after [previous] reconnects every
         * stream: a read on a socket whose network went away does not fail by
         * itself, so after a loss ([lost]) or a change every open stream is
         * dead. The first network only lets waiting streams connect.
         */
        fun <N : Any> reconnects(previous: N?, lost: Boolean, available: N): Boolean =
            previous != null && (lost || previous != available)

        /** JavaScript's answer to the service's request for credentials. */
        fun deliver(answer: DirectPushCredentials.Answer) {
            UiThreadUtil.runOnUiThread { running?.answered(answer) }
        }
    }
}
