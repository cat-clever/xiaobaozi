package com.baozivideo.glass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 液态玻璃容器（Android 侧）。
 *
 * ★★ 这一版**真的去抓背后的内容来糊**了，不再是"渐变 + 高光"的近似。
 *
 *   为什么以前不敢做：Android 没有现成的"糊背后"API ——
 *   `RenderEffect` 糊的是**自己画的内容**，`Window.setBackgroundBlurRadius`
 *   只对整个窗口生效。想糊背后，只能自己抓一份。
 *
 *   抓法：在**每帧绘制之前**（`ViewTreeObserver.OnPreDrawListener`）把自己
 *   那一层（= GlassBox 那个胶囊，含玻璃 + 上面的文字 / 指示胶囊）临时置
 *   `INVISIBLE`，把**顶层视图**（`rootView`，公开 API；`View.getWindow()`
 *   不是公开 API、Kotlin 编不过）画进一张**缩小的位图**（画布平移 + 缩放，
 *   只映射我们这个区域），画完立刻还原。于是拿到的正是"没有玻璃时"的背景。
 *   接着：
 *
 *     1. 缩小 → **箱式模糊**（在 1/6 大小的位图上做，代价可以忽略）
 *     2. 抬一点**饱和度**（真玻璃会把背后的颜色调得更浓，iOS 也这么干）
 *     3. 用 **`drawBitmapMesh`** 做"边缘透镜"位移 —— 越靠边采样点越往外拉，
 *        背景在边上看起来被压缩 / 放大，就是玻璃边缘那一圈折光
 *     4. 叠原来的色调渐变 + 上缘高光 + 描边
 *
 * ★ 抓取是**节流**的（150ms 一次）：滚动时背景最多旧一帧多一点，糊过之后
 *   根本看不出来；换来的是 8 次/秒的抓取，而不是每帧都抓。
 * ★ 任何一步出问题（拿不到 window、找不到该藏的层、绘制抛异常）都**永久退回**
 *   原来的渐变近似 —— 玻璃再好看也不能把 App 搞崩。
 * ★ 触摸行为一点没变：`isClickable = false`，玻璃只画不接。
 */
class GlassView(context: Context) : View(context) {

  var cornerRadius: Float = 0f
    set(value) {
      field = value
      rebuild()
      invalidate()
    }

  /** "dark" / "light" */
  var glassStyle: String = "dark"
    set(value) {
      field = value
      rebuild()
      invalidate()
    }

  // ---------------- 背景抓取 ----------------

  /** 缩到 1/6 再糊：糊的是缩略图，快且更平滑 */
  private val backdropScale = 6f
  private var backdrop: Bitmap? = null
  private var backdropCanvas: Canvas? = null
  /** 抓过一次就不抓了（任何异常都走这条） */
  private var captureBroken = false
  private var lastCaptureAt = 0L
  private var capturing = false
  /** 两次抓取之间至少隔多久：按上一次的实际开销自适应（见 `maybeCapture`） */
  private var nextIntervalMs = CAPTURE_INTERVAL_MS

  private val preDrawListener =
    ViewTreeObserver.OnPreDrawListener {
      maybeCapture()
      true
    }

  // ---------------- 透镜网格 ----------------

  /** 网格密度：够画出边缘那圈位移，又便宜 */
  private val meshW = 16
  private val meshH = 6
  private var meshVerts = FloatArray(0)
  private val meshPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val clipPath = Path()

  // ---------------- 画笔 ----------------

  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  /** 衬底：`theme` 那层透光底的等价物，见 `rebuild()` 的说明 */
  private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  /** 顶边高光之下那层**柔和镜面反射**：白渐变，让玻璃"亮起来" */
  private val sheenPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  /** 底部**内侧阴影**：让玻璃有厚度，不是一张薄贴片 */
  private val innerShadowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()

  init {
    // 普通 View 子类默认不回调 onDraw，必须显式打开
    setWillNotDraw(false)
    // ★ 不设 clickable —— 这样触摸会**穿透**到下面的手势层 / 上面的按钮，
    //   玻璃只负责画，不参与命中测试
    isClickable = false
    isFocusable = false
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(preDrawListener)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDrawListener)
    // 位图跟着走，别在后台占着
    backdrop?.recycle()
    backdrop = null
    backdropCanvas = null
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    rect.set(0f, 0f, w.toFloat(), h.toFloat())
    rebuild()
    invalidate()
  }

  /** 主题 / 圆角 / 尺寸变了就重算：颜色、渐变、透镜网格 */
  private fun rebuild() {
    val light = glassStyle == "light"
    val height = rect.height().coerceAtLeast(1f)

    // ★ 背景现在是**真的糊过的**了，但这不等于"不用垫底"：
    //   JS 侧那层透光底（`theme` 里的 `bar`）在抓背景时被我们**一起藏了**
    //   （藏的是整条胶囊，见 `hostToHide`），所以对比度得从这里补回来 ——
    //   不然亮海报从背后透上来，白字就看不清了。
    //
    //   ★ 取的是 `bar` 的 **iOS 那一档**（深色 0.52 / 亮色 0.62）：
    //     theme 里 Android 之所以更实（0.66 / 0.75），理由正是"Android 没有
    //     背景模糊"。现在有了，就该用更透的那档，否则糊了也白糊。
    //     （改 `theme/index.ts` 的 `bar` 时记得同步这里。）
    // 浅色里压一点（158 -> 132）：用户报"几乎白色"，就是白釉压不住，
    // 把糊过的**海报颜色**再放出来一点。
    scrimPaint.color =
      if (light) Color.argb(132, 255, 255, 255) else Color.argb(133, 16, 16, 22)

    // 上亮下暗的"厚度" + 上缘高光。值跟以前一样 —— 这层是**垫在衬底之上**的
    // 那点提亮，跟有没有真模糊无关。
    // 浅色的上亮下白再压一点（226 -> 180, 126 -> 90）……
    val top = if (light) Color.argb(180, 255, 255, 255) else Color.argb(52, 255, 255, 255)
    val bottom = if (light) Color.argb(90, 255, 255, 255) else Color.argb(24, 255, 255, 255)
    fillPaint.shader = LinearGradient(0f, 0f, 0f, height, top, bottom, Shader.TileMode.CLAMP)

    // ★ 顶边柔和**镜面反射**：真玻璃顶边的蓝/白渐变，
    //   只扫表面的前 22%
    sheenPaint.shader = LinearGradient(
      0f, 0f, 0f, height * 0.22f,
      if (light) Color.argb(40, 255, 255, 255) else Color.argb(26, 255, 255, 255),
      Color.argb(0, 255, 255, 255),
      Shader.TileMode.CLAMP,
    )

    // ★ 底部**内侧柔和阴影**：玻璃有厚度，不是薄贴片
    innerShadowPaint.shader = LinearGradient(
      0f, height * 0.72f, 0f, height,
      Color.argb(0, 0, 0, 0),
      if (light) Color.argb(46, 0, 0, 0) else Color.argb(70, 0, 0, 0),
      Shader.TileMode.CLAMP,
    )

    highlightPaint.color =
      if (light) Color.argb(190, 255, 255, 255) else Color.argb(118, 255, 255, 255)

    borderPaint.style = Paint.Style.STROKE
    borderPaint.strokeWidth = dp(0.5f)
    borderPaint.color = if (light) Color.argb(170, 255, 255, 255) else Color.argb(92, 255, 255, 255)

    rebuildMesh()
  }

  /**
   * 重算"边缘透镜"网格。
   *
   * `drawBitmapMesh` 的网格顶点是**目标位置**：位图被均匀切成 (meshW+1)×(meshH+1)
   * 个点，每个点画到 verts 里对应的位置上。所以把边上的顶点**往外挪**，
   * 就等于"把靠里的内容搬到边上" —— 背景在边缘被压缩 / 放大，正是玻璃边缘的折光。
   *
   * 位移量按到边界的距离取：边上最大（`lensStrength`），往里一个 `lensBand` 就归零，
   * 中间区域完全不动（否则整块背景都在飘，像果冻）。
   */
  private fun rebuildMesh() {
    val w = rect.width()
    val h = rect.height()
    if (w <= 0f || h <= 0f) {
      meshVerts = FloatArray(0)
      return
    }

    val count = (meshW + 1) * (meshH + 1)
    if (meshVerts.size != count * 2) meshVerts = FloatArray(count * 2)

    val r = min(cornerRadius, min(w, h) / 2f)
    val halfW = w / 2f
    val halfH = h / 2f
    val band = min(halfH, dp(11f))
    val strength = dp(4.0f)
    val eps = 0.5f

    var i = 0
    for (gy in 0..meshH) {
      for (gx in 0..meshW) {
        val x = w * gx / meshW
        val y = h * gy / meshH

        // 圆角矩形的有符号距离：< 0 在内部，绝对值就是"离边界多远"
        val cx = x - halfW
        val cy = y - halfH
        val inside = -sdRoundRect(cx, cy, halfW, halfH, r)

        val t = ((band - inside) / band).coerceIn(0f, 1f)
        var dx = 0f
        var dy = 0f
        if (t > 0f) {
          // 法线 = 距离场的梯度（指向外侧，SDF 往外变大）
          val gx2 =
            sdRoundRect(cx + eps, cy, halfW, halfH, r) -
              sdRoundRect(cx - eps, cy, halfW, halfH, r)
          val gy2 =
            sdRoundRect(cx, cy + eps, halfW, halfH, r) -
              sdRoundRect(cx, cy - eps, halfW, halfH, r)
          val len = hypot(gx2, gy2)
          if (len > 1e-4f) {
            // 平方：中间平滑过渡，最边上最明显
            val amount = strength * t * t
            dx = gx2 / len * amount
            dy = gy2 / len * amount
          }
        }

        meshVerts[i++] = x + dx
        meshVerts[i++] = y + dy
      }
    }

    // ★ 万一算出 NaN / Inf（尺寸或圆角异常），整块网格就别用了 ——
    //   拿坏数据去 `drawBitmapMesh` 会把玻璃画花。退回"整张位图直接贴"。
    for (v in meshVerts) {
      if (!v.isFinite()) {
        meshVerts = FloatArray(0)
        return
      }
    }
  }

  /** 圆角矩形有符号距离（标准 SDF，glsl 那套写成 Kotlin） */
  private fun sdRoundRect(px: Float, py: Float, halfW: Float, halfH: Float, r: Float): Float {
    val qx = abs(px) - halfW + r
    val qy = abs(py) - halfH + r
    val ox = max(qx, 0f)
    val oy = max(qy, 0f)
    return hypot(ox, oy) + min(max(qx, qy), 0f) - r
  }

  // ---------------- 抓取 ----------------

  private fun maybeCapture() {
    if (captureBroken || capturing) return
    if (!isShown || width <= 0 || height <= 0) return
    val now = SystemClock.uptimeMillis()
    if (now - lastCaptureAt < nextIntervalMs) return
    lastCaptureAt = now
    val started = now
    try {
      captureBackdrop()
      // ★ 自适应节流：抓一次不许占掉太多时间。慢机器上（一次要 30ms）
      //   自动降到 3 次/秒左右，宁可背景旧一点，也不能把滚动拖卡。
      val cost = SystemClock.uptimeMillis() - started
      nextIntervalMs = (cost * 10).coerceIn(CAPTURE_INTERVAL_MS, MAX_CAPTURE_INTERVAL_MS)
    } catch (_: Throwable) {
      captureBroken = true
      backdrop = null
      backdropCanvas = null
      invalidate()
    }
  }

  private fun captureBackdrop() {
    // ★ 用 `rootView`（`View.getRootView()`，公开 API）拿顶层视图：
    //   `View.getWindow()` **不是**公开 API，Kotlin 里直接编不过（踩过）。
    val root: View = rootView
    val host = hostToHide(root) ?: return

    val w = max(1, (width / backdropScale).toInt())
    val h = max(1, (height / backdropScale).toInt())

    var bitmap = backdrop
    if (bitmap == null || bitmap.width != w || bitmap.height != h) {
      bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      backdrop = bitmap
      backdropCanvas = Canvas(bitmap)
    }
    val canvas = backdropCanvas ?: return
    canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)

    // 自己在窗口里的位置 —— 换算成**相对 rootView 左上角**的偏移：
    // 待会儿画的是 rootView，两个坐标都在窗口坐标系里，减一下就对齐了
    val loc = IntArray(2)
    val rootLoc = IntArray(2)
    getLocationInWindow(loc)
    root.getLocationInWindow(rootLoc)
    val dx = (loc[0] - rootLoc[0]).toFloat()
    val dy = (loc[1] - rootLoc[1]).toFloat()

    val previous = host.visibility
    capturing = true
    host.visibility = View.INVISIBLE
    try {
      val save = canvas.save()
      canvas.scale(1f / backdropScale, 1f / backdropScale)
      canvas.translate(-dx, -dy)
      root.draw(canvas)
      canvas.restoreToCount(save)
    } finally {
      host.visibility = previous
      capturing = false
    }

    boxBlur(bitmap, 3)
    saturate(bitmap, 1.18f)
    invalidate()
  }

  /**
   * 找出**该临时藏起来的那一层**。
   *
   * ★ 必须把"玻璃上面的内容"（Tab 文字、那个滑动的指示胶囊）也一起藏掉：
   *   只藏玻璃自己的话，它们会被抓进背景里，再糊一遍再画一遍 ——
   *   文字会在玻璃里留一层糊掉的鬼影，指示胶囊会变成一块双层的奶白。
   *   而且玻璃自己也会被抓进去 → 自己的输出当下一次的输入，越叠越糊。
   *
   * ★ 但尺寸**必须跟我们一样**：沿着父链一直往上，直到某一层变大为止。
   *   因为 `NativeGlass` 是 `position: absolute; inset: 0`，从玻璃往上到
   *   GlassBox 的胶囊、再到外面那几层纯包装（Pressable / Animated.View /
   *   pan View）**尺寸全都跟我们一样**，而再往上（tabBarWrap）就是整屏宽了。
   *   于是"最后一个同尺寸的祖先"正好是这一整条胶囊，多一点都没藏。
   *
   * ★ 加一道保险：**整屏那么大的层不藏**（那种情况下藏掉会把 App 内容
   *   一起藏没，背景就空了）。宁可退回渐变近似。
   *
   *   `root` = `rootView`（顶层视图），拿它的尺寸当"整屏"的参照。
   */
  private fun hostToHide(root: View): View? {
    var host: View? = null
    var node = parent as? View
    var level = 0
    while (node != null && level < 8) {
      if (node.width != width || node.height != height) break
      if (root.width > 0 && root.height > 0 &&
        node.width >= root.width * 9 / 10 && node.height >= root.height * 9 / 10
      ) {
        break
      }
      host = node
      node = node.parent as? View
      level++
    }
    return host
  }

  /**
   * 箱式模糊（水平 + 垂直各一趟）。
   *
   * ★ 故意不用 `RenderEffect.createBlurEffect`：那是 API 31+，还得先包一层
   *   `RenderNode`；而我们糊的是**缩小过的**位图，箱式两趟就够快也够平滑。
   */
  private fun boxBlur(bitmap: Bitmap, radius: Int) {
    if (radius < 1) return
    val w = bitmap.width
    val h = bitmap.height
    if (w <= 0 || h <= 0) return

    val count = w * h
    val pixels = IntArray(count)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
    val temp = IntArray(count)

    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        var a = 0
        var r = 0
        var g = 0
        var b = 0
        var n = 0
        val from = max(0, x - radius)
        val to = min(w - 1, x + radius)
        for (i in from..to) {
          val c = pixels[row + i]
          a += (c ushr 24) and 0xFF
          r += (c ushr 16) and 0xFF
          g += (c ushr 8) and 0xFF
          b += c and 0xFF
          n++
        }
        temp[row + x] = ((a / n) shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
      }
    }

    for (x in 0 until w) {
      for (y in 0 until h) {
        var a = 0
        var r = 0
        var g = 0
        var b = 0
        var n = 0
        val from = max(0, y - radius)
        val to = min(h - 1, y + radius)
        for (i in from..to) {
          val c = temp[i * w + x]
          a += (c ushr 24) and 0xFF
          r += (c ushr 16) and 0xFF
          g += (c ushr 8) and 0xFF
          b += c and 0xFF
          n++
        }
        pixels[y * w + x] =
          ((a / n) shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
      }
    }

    bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
  }

  /**
   * 抬饱和度。
   *
   * 真玻璃不是单纯把背后糊一下 —— 它同时把颜色"滤"得更浓（iOS 的 `UIGlassEffect`
   * 就是这个观感）。糊完再补一步，玻璃才有"活的"质感，而不是一层灰膜。
   */
  private fun saturate(bitmap: Bitmap, amount: Float) {
    val w = bitmap.width
    val h = bitmap.height
    if (w <= 0 || h <= 0) return
    val count = w * h
    val pixels = IntArray(count)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

    for (i in 0 until count) {
      val c = pixels[i]
      val a = (c ushr 24) and 0xFF
      if (a == 0) continue
      val r = (c ushr 16) and 0xFF
      val g = (c ushr 8) and 0xFF
      val b = c and 0xFF
      // 亮度（Rec.601 那组权重够用）
      val luma = (r * 77 + g * 151 + b * 28) shr 8
      val nr = (luma + (r - luma) * amount).toInt().coerceIn(0, 255)
      val ng = (luma + (g - luma) * amount).toInt().coerceIn(0, 255)
      val nb = (luma + (b - luma) * amount).toInt().coerceIn(0, 255)
      pixels[i] = (a shl 24) or (nr shl 16) or (ng shl 8) or nb
    }

    bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
  }

  // ---------------- 绘制 ----------------

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (rect.isEmpty) return

    val radius = cornerRadius
    val bitmap = backdrop
    var painted = false

    if (bitmap != null && !bitmap.isRecycled) {
      // 圆角裁一下：糊过的背景 + 衬底 + 色调一起裁，边上才不会露出方角
      val save = canvas.save()
      try {
        clipPath.reset()
        clipPath.addRoundRect(rect, radius, radius, Path.Direction.CW)
        canvas.clipPath(clipPath)

        if (meshVerts.isNotEmpty()) {
          // ★ Android 的 `drawBitmapMesh` 只有 8 个参数（没有 iOS/Skia 那个
          //   `filter` 布尔）—— 多写一个 `null` 直接编不过（踩过）。
          canvas.drawBitmapMesh(
            bitmap,
            meshW,
            meshH,
            meshVerts,
            0,
            null,
            0,
            meshPaint,
          )
        } else {
          canvas.drawBitmap(bitmap, null, rect, meshPaint)
        }

        // 衬底（补被抓走的那层透光底）+ 上亮下暗的色调
        canvas.drawRoundRect(rect, radius, radius, scrimPaint)
        canvas.drawRoundRect(rect, radius, radius, fillPaint)
        canvas.drawRoundRect(rect, radius, radius, sheenPaint)
        canvas.drawRoundRect(rect, radius, radius, innerShadowPaint)
        painted = true
      } catch (_: Throwable) {
        // ★ 真玻璃这条路上任何一步炸了，就地**永久**退回渐变近似 ——
        //   宁可少一层糊，也不能每帧在 onDraw 里抛异常。
        captureBroken = true
        backdrop = null
        backdropCanvas = null
      } finally {
        canvas.restoreToCount(save)
      }
    }

    if (!painted) {
      // ★ 兜底：抓不到背景（或抓炸了）时，回到原来那套"渐变 + 高光"的近似。
      //   观感差一档，但绝对不会白屏 / 花屏。
      canvas.drawRoundRect(rect, radius, radius, fillPaint)
      canvas.drawRoundRect(rect, radius, radius, sheenPaint)
      canvas.drawRoundRect(rect, radius, radius, innerShadowPaint)
    }

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

  private fun dp(value: Float): Float = value * resources.displayMetrics.density

  private companion object {
    /** 抓取间隔：8 次/秒左右，够跟手了 */
    const val CAPTURE_INTERVAL_MS = 150L
    /** 机器慢的时候最多降到这个间隔（≈2 次/秒） */
    const val MAX_CAPTURE_INTERVAL_MS = 600L
  }
}
