package com.baozivideo

import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.baozivideo.input.InputModeModule
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "BaoziVideo"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * ★★ 遥控器 / 触摸输入识别。
   *
   *   焦点环只在"遥控器介入"时显示：方向键/确认键按下 -> remote=true，
   *   手指按下 -> remote=false。JS 侧据此决定画不画焦点环。
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN && isRemoteKey(event.keyCode)) {
      InputModeModule.note(true)
    }
    return super.dispatchKeyEvent(event)
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (ev.actionMasked == MotionEvent.ACTION_DOWN) InputModeModule.note(false)
    return super.dispatchTouchEvent(ev)
  }

  private fun isRemoteKey(code: Int): Boolean =
    code in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_CENTER ||
      code == KeyEvent.KEYCODE_ENTER ||
      code == KeyEvent.KEYCODE_NUMPAD_ENTER ||
      code in KeyEvent.KEYCODE_MEDIA_PLAY..KeyEvent.KEYCODE_MEDIA_FAST_FORWARD

  /**
   * ★★ 遥控器焦点引导。
   *
   *   RN 的 `BaseViewManager` 会把每个 View 的 `focusableInTouchMode` 强制
   *   置 false —— 在**触摸模式**的设备（部分电视盒子、手机接 HDMI）上，
   *   方向键就永远移不动焦点。这里在每次布局后把可点/可聚焦的 View 补上
   *   `focusableInTouchMode`，并在整棵树都没有焦点时把焦点给第一个可点项。
   *
   *   触摸时 JS 会收到 remote=false，所以补这个标志**不会**让手指点出焦点环。
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val decor = window.decorView
    decor.viewTreeObserver.addOnGlobalLayoutListener {
      applyDpadFocus(decor)
      if (decor.findFocus() == null) requestFirstFocus(decor)
    }
  }

  private fun applyDpadFocus(view: View) {
    // ★ 跳过输入框：ReactEditText 故意把 focusableInTouchMode 置 false
    //   （触摸由 JS 管理，避免键盘乱弹）。补上去会破坏搜索框。
    if (view is android.widget.EditText) return
    if ((view.isClickable || view.isFocusable) && !view.isFocusableInTouchMode) {
      view.isFocusableInTouchMode = true
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) applyDpadFocus(view.getChildAt(i))
    }
  }

  private fun requestFirstFocus(view: View): Boolean {
    if (!view.isShown || view is android.widget.EditText) return false
    if (view.isFocusableInTouchMode && (view.isClickable || view.isFocusable)) {
      if (view.requestFocus()) return true
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        if (requestFirstFocus(view.getChildAt(i))) return true
      }
    }
    return false
  }
}
