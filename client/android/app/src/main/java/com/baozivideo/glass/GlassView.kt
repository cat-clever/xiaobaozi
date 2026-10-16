package com.baozivideo.glass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.View

/**
 * 液态玻璃容器（Android 侧）。
 *
 * ★ 说清楚一件事：**Android 上拿不到真正的"背景模糊"**。
 *   `UIVisualEffectView` 那种把背后内容糊开的能力，Android 侧只有两条路 ——
 *   `Window.setBackgroundBlurRadius()`（只对整个窗口生效，用在对话框上）和
 *   `RenderEffect`（糊的是**自己**画的内容，不是背后的）。想在 App 内对任意
 *   区域做背景模糊，只能拿 `PixelCopy` 抓一张窗口快照再自己糊，代价是要跟着
 *   滚动不断重抓，很脆。
 *
 *   所以这里做的是**高质量近似**：纵向渐变底 + 上缘高光 + 描边，
 *   视觉上跟 iOS 那套是同一个设计语言，只是背后那层没有被真正糊开。
 *   真要上 PixelCopy 那条路，见《改动记录.md》里记的方案。
 */
class GlassView(context: Context) : View(context) {

  var cornerRadius: Float = 0f
    set(value) {
      field = value
      invalidate()
    }

  /** "dark" / "light" */
  var glassStyle: String = "dark"
    set(value) {
      field = value
      rebuild()
      invalidate()
    }

  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()

  init {
    // 普通 View 子类默认不回调 onDraw，必须显式打开
    setWillNotDraw(false)
    // ★ 不设 clickable —— 这样触摸会**穿透**到下面的手势层 / 上面的按钮，
    //   玻璃只负责画，不参与命中测试
    isClickable = false
    isFocusable = false
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    rect.set(0f, 0f, w.toFloat(), h.toFloat())
    rebuild()
  }

  private fun rebuild() {
    val light = glassStyle == "light"
    val height = rect.height().coerceAtLeast(1f)

    // 上亮下暗的纵向渐变 —— 玻璃"折光"的那点意思。
    // ★ 深色下的这组数值调过一轮：原来是 30/14（约 12%/5%），
    //   跟纯色面板的 6% 几乎看不出差别，用户反馈"安卓没做出效果"。
    //   现在拉到 20%/9%，再把上缘高光和描边一起提亮，才立得住。
    val top = if (light) Color.argb(238, 255, 255, 255) else Color.argb(52, 255, 255, 255)
    val bottom = if (light) Color.argb(148, 255, 255, 255) else Color.argb(24, 255, 255, 255)
    fillPaint.shader = LinearGradient(0f, 0f, 0f, height, top, bottom, Shader.TileMode.CLAMP)

    highlightPaint.color = if (light) Color.argb(235, 255, 255, 255) else Color.argb(118, 255, 255, 255)

    borderPaint.style = Paint.Style.STROKE
    borderPaint.strokeWidth = resources.displayMetrics.density * 0.5f
    borderPaint.color = if (light) Color.argb(200, 255, 255, 255) else Color.argb(92, 255, 255, 255)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (rect.isEmpty) return

    val radius = cornerRadius
    canvas.drawRoundRect(rect, radius, radius, fillPaint)

    // 上缘高光：一条贴着顶边的白线，两端让开圆角
    val inset = radius.coerceAtMost(rect.width() / 2f)
    if (rect.width() > inset * 2f) {
      canvas.drawLine(inset, 1f, rect.width() - inset, 1f, highlightPaint)
    }

    val half = borderPaint.strokeWidth / 2f
    rect.inset(half, half)
    canvas.drawRoundRect(rect, radius, radius, borderPaint)
    rect.inset(-half, -half)
  }
}
