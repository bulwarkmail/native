package com.anonymous.bulwarkmobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    ShareIntentStore.rewriteSendToAsView(intent)
    super.onCreate(null)
    NotificationTapStore.captureFromIntent(intent)
    ShareIntentStore.captureFromIntent(intent, contentResolver)
  }

  override fun onResume() {
    super.onResume()
    isInForeground = true
  }

  override fun onPause() {
    isInForeground = false
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    ShareIntentStore.rewriteSendToAsView(intent)
    super.onNewIntent(intent)
    setIntent(intent)
    ShareIntentStore.captureFromIntent(intent, contentResolver)?.let { share ->
      BulwarkFcmModule.emit("app:share", share.toMap())
    }
    val payload = NotificationTapStore.captureFromIntent(intent) ?: return
    BulwarkFcmModule.emit("fcm:notificationTap", payload.toMap())
  }

  // Where the mouse pointer is, for rehover(). Android reports a pointer only
  // when it moves, so a view that moves under a still pointer (a list
  // scrolled by the wheel, a row deleted) is never told it is hovered.
  private var pointerX = 0f
  private var pointerY = 0f
  private var pointerDevice = 0
  private var pointerOverWindow = false
  private var pointerPressed = false

  private fun isMouse(ev: MotionEvent) =
    ev.isFromSource(InputDevice.SOURCE_MOUSE) && ev.getToolType(0) == MotionEvent.TOOL_TYPE_MOUSE

  override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
    if (isMouse(ev)) {
      when (ev.actionMasked) {
        MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> {
          pointerX = ev.x
          pointerY = ev.y
          pointerDevice = ev.deviceId
          pointerOverWindow = true
        }
        // Also sent just before a button goes down; dispatchTouchEvent puts that right.
        MotionEvent.ACTION_HOVER_EXIT -> pointerOverWindow = false
      }
    }
    return super.dispatchGenericMotionEvent(ev)
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (isMouse(ev)) {
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> pointerPressed = true
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> pointerPressed = false
      }
      pointerX = ev.x
      pointerY = ev.y
      pointerDevice = ev.deviceId
      pointerOverWindow = true
    }
    return super.dispatchTouchEvent(ev)
  }

  /**
   * Sends the views a hover move at the place the mouse pointer was last
   * seen, so that the view now under it becomes the hovered one. Does nothing
   * without a mouse over this window, or while a button is held.
   *
   * A dialog is a window of its own: while the pointer is on one this window
   * does not know where it is, and nothing is sent until it moves here again.
   */
  fun rehover() {
    if (!pointerOverWindow || pointerPressed) return
    if (InputDevice.getDevice(pointerDevice) == null) {
      // The mouse was unplugged.
      pointerOverWindow = false
      return
    }
    val now = SystemClock.uptimeMillis()
    val properties = arrayOf(MotionEvent.PointerProperties().apply {
      id = 0
      toolType = MotionEvent.TOOL_TYPE_MOUSE
    })
    val coords = arrayOf(MotionEvent.PointerCoords().apply {
      x = pointerX
      y = pointerY
    })
    val move = MotionEvent.obtain(
      now, now, MotionEvent.ACTION_HOVER_MOVE, 1, properties, coords,
      0, 0, 1f, 1f, pointerDevice, 0, InputDevice.SOURCE_MOUSE, 0,
    )
    window.superDispatchGenericMotionEvent(move)
    move.recycle()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  companion object {
    /**
     * Whether the app's screen is resumed, the state in which React Native
     * refuses to start a headless task (HeadlessJsTaskContext). Pushes read
     * it to decide whether the push task runs (BulwarkMessagingService).
     */
    @Volatile
    @JvmStatic
    var isInForeground = false
      private set
  }
}
