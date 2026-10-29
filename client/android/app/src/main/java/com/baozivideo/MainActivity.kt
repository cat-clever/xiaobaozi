package com.baozivideo

import android.os.Bundle
import android.os.SystemClock
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
  /** 同一个遥控器键的去重窗口（毫秒） */
  private var lastRemoteKeyCode = 0
  private var lastRemoteKeyAt = 0L

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN && isRemoteKey(event.keyCode)) {
      InputModeModule.note(true)
      // ★★ 遥控器按住方向键/确认键时，Android 会快速重复发送 ACTION_DOWN
      //   （repeatCount 从 0 开始递增）。RN 的焦点系统对每一次 ACTION_DOWN
      //   都会执行一次焦点移动 —— 所以按一下方向键，焦点就跳了两三格。
      if (event.repeatCount > 0) return true

      // ★★ 更隐蔽的一类：有些遥控器/盒子会把**一次物理按键**拆成多次
      //   独立的 ACTION_DOWN（repeatCount 全是 0）。上面的 repeatCount
      //   过滤挡不住，而 JS 的 onPress 防抖也管不到**焦点移动**（焦点是
      //   Android 在 key down 时直接处理的，不经过 onPress）。
      //   所以在这里对**同一个键**再做一次时间窗去重（用户 2026-10-21 反馈
      //   "点一下跳了好几个"）。
      //
      // ★★ 窗口从 150ms 收到 60ms（2026-10-29）。150ms 太宽了：一次物理
      //   按键拆出来的重复事件间隔只有几毫秒，而**人连按两下方向键**经常
      //   就在 100ms 出头 —— 第二下会被当成重复事件**吃掉**。表现是
      //   "在 Tab 栏按左右没反应 / 走一格就停"（用户报的"Tab 无法遥控"）。
      //   60ms 仍然挡得住拆分按键，又允许每秒十几下的正常连按。
      val now = SystemClock.uptimeMillis()
      if (event.keyCode == lastRemoteKeyCode &&
        now - lastRemoteKeyAt < REMOTE_KEY_DEBOUNCE_MS
      ) {
        return true
      }
      lastRemoteKeyCode = event.keyCode
      lastRemoteKeyAt = now

      val decor = window.decorView
      applyDpadFocus(decor)
      val beforeFocus = decor.findFocus()
      val handled = super.dispatchKeyEvent(event)
      // ★★ 底部 Tab 栏是 position: absolute 浮在 ScrollView 上方的：
      //   1. 列表滚到底部时，ScrollView 会先吞下键去滚 paddingBottom，或者卡片底边
      //      （贴屏幕底）低于悬浮 Tab 栏底边（离底 24dp），导致 FocusFinder 判定
      //      Tab 栏不在卡片正下方而拒绝转移焦点；
      //   2. 必须在 super.dispatchKeyEvent 之后检查 canScrollDown：在最后一排卡片按
      //      下键时，按键前还有 102dp 的 paddingBottom 没滚完（canScrollVertically(1)
      //      为 true），super.dispatchKeyEvent 会一次性把这段空白滚到底（此时
      //      canScrollDown 变为 false），紧接着把焦点交给底部 Tab，无需按两下。
      if (event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN && !isTabView(beforeFocus) && !canScrollDown(beforeFocus)) {
        val afterFocus = decor.findFocus()
        if (afterFocus == null || afterFocus === beforeFocus) {
          val activeTab = decor.findViewWithTag<View>("tab-active")
          if (activeTab != null && activeTab.isShown && activeTab.isFocusableInTouchMode) {
            if (activeTab.requestFocus()) return true
          }
        }
      }
      return handled
    }
    return super.dispatchKeyEvent(event)
  }

  private companion object {
    /**
     * 同键去重窗口。
     *
     * ★ 60ms：拆分按键的重复事件只隔几毫秒，够挡住；而人连按方向键
     *   通常 100ms 以上，不会被误吃（150ms 会 —— 见 dispatchKeyEvent 里的说明）。
     */
    const val REMOTE_KEY_DEBOUNCE_MS = 60L
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (ev.actionMasked == MotionEvent.ACTION_DOWN) InputModeModule.note(false)
    return super.dispatchTouchEvent(ev)
  }

  private fun isRemoteKey(code: Int): Boolean =
    code in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_CENTER ||
      code == KeyEvent.KEYCODE_ENTER ||
      code == KeyEvent.KEYCODE_NUMPAD_ENTER ||
      // 媒体键：85..90 是 PLAY_PAUSE/STOP/NEXT/PREVIOUS/REWIND/FAST_FORWARD，
      // PLAY(126) / PAUSE(127) 不连续，单独列
      code in KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE..KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ||
      code == KeyEvent.KEYCODE_MEDIA_PLAY ||
      code == KeyEvent.KEYCODE_MEDIA_PAUSE

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
      if (decor.findFocus() == null) requestInitialFocus(decor)
    }
  }

  /** 检查祖先滚动容器（FlatList / ScrollView）是否还能继续向下滚动 */
  private fun canScrollDown(view: View?): Boolean {
    var node = view?.parent as? View
    while (node != null) {
      if (node.canScrollVertically(1)) return true
      node = node.parent as? View
    }
    return false
  }

  private fun isTabView(view: View?): Boolean {
    val tag = view?.tag as? String ?: return false
    return tag == "tab-active" || tag.startsWith("tab-")
  }

  private fun applyDpadFocus(view: View) {
    // ★ 跳过输入框：ReactEditText 故意把 focusableInTouchMode 置 false
    //   （触摸由 JS 管理，避免键盘乱弹）。补上去会破坏搜索框。
    if (view is android.widget.EditText) return
    if (view is ViewGroup) {
      if (view.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) {
        view.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        return
      }
      if (view.descendantFocusability == ViewGroup.FOCUS_BLOCK_DESCENDANTS) {
        view.descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
      }
    }
    // ★ 只补**可点**的 View（Pressable / Switch）。ScrollView 之类只是
    //   focusable、不可点 —— 把它们也变成焦点目标的话，方向键会停在
    //   滚动容器上，看起来就是"条目选不对 / 焦点乱跳"。
    if (view.isClickable && !view.isFocusableInTouchMode) {
      view.isFocusableInTouchMode = true
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) applyDpadFocus(view.getChildAt(i))
    }
  }

  private fun requestInitialFocus(decor: View) {
    // ★ 优先聚焦底部当前选中的 Tab（"tab-active"）：
    //   按树顺序遍历时右上角「设置」排在最前面，直接走 requestFirstFocus
    //   会把初始焦点和从设置页返回后的焦点全都塞给「设置」按钮。
    val activeTab = decor.findViewWithTag<View>("tab-active")
    if (activeTab != null && activeTab.isShown && activeTab.isClickable && activeTab.isFocusableInTouchMode) {
      if (activeTab.requestFocus()) return
    }
    requestFirstFocus(decor)
  }

  private fun requestFirstFocus(view: View): Boolean {
    if (!view.isShown || view is android.widget.EditText) return false
    if (view.isClickable && view.isFocusableInTouchMode) {
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
