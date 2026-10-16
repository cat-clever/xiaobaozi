package com.baozivideo.glass.kyant

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import com.kyant.backdrop.backdrops.rememberCanvasBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy
import kotlin.math.max

/**
 * Kyant `backdrop` 那套材质的**输入**：一张「没有自己时身后的样子」的位图。
 *
 * ★ 为什么要自己抓：Android 没有"糊背后"的 API ——
 *   `RenderEffect` 糊的是**自己画的内容**，`Window.setBackgroundBlurRadius`
 *   只对整个窗口生效。所以只能趁每帧绘制之前，把自己那一层临时 `INVISIBLE`，
 *   把顶层视图画进一张缩小的位图，画完立刻还原。抓法跟 `GlassView.kt`
 *   那套一模一样（那边是自绘箱式模糊，这边喂给 `RenderEffect`）。
 *
 * ★ 抓取是**节流**的：滚动时背景最多旧一帧多一点，糊过之后根本看不出来；
 *   换来的是几帧一次而不是每帧都抓。间隔按上一次的实际开销自适应，
 *   慢机器自动降频。
 *
 * ★ 任何一步出问题都**永久停抓**（`broken`）—— 拿不到位图时 Compose 那边
 *   会退化成只有高光的近似，绝不白屏、绝不每帧抛异常。
 */
class BackdropCapture(
    private val host: View,
    /** 缩到几分之一再抓：Kyant 那侧自己会糊，所以不用像 `GlassView` 那样缩到 1/6 */
    private val scale: Float = 2f,
    /**
     * 在自己四周**额外**多抓这么多像素 —— 必须**正好等于**材质层的 `padding`
     * （= `max(0, blurRadius - refractionHeight)`，见 `KyantGlass` 的说明）。
     *
     * ★ 大了小了都会错位：材质层是 `size + 2*padding`、原点在 `-padding`，
     *   位图必须覆盖同一块区域，`dstOffset` 才能用 `-padding` 对齐。
     */
    private val marginPx: Int,
) {

    /** 抓好的位图。Compose 侧读它；没抓到 / 抓坏了就是 null（走兜底） */
    val bitmap = mutableStateOf<Bitmap?>(null)

    private var canvas: android.graphics.Canvas? = null
    private var broken = false
    private var capturing = false
    private var lastAt = 0L
    private var intervalMs = BASE_INTERVAL_MS

    private val listener = ViewTreeObserver.OnPreDrawListener {
        maybeCapture()
        true
    }

    fun attach() {
        host.viewTreeObserver.addOnPreDrawListener(listener)
    }

    fun detach() {
        host.viewTreeObserver.removeOnPreDrawListener(listener)
        // ★ 这里**故意不 `recycle()`**：Compose 那边可能还攥着上一次
        //   `asImageBitmap()` 的结果，回收掉会变成"画一张已回收的位图"直接崩。
        //   丢引用交给 GC 就行 —— 位图的内存本来就归它管。
        bitmap.value = null
        canvas = null
    }

    private fun maybeCapture() {
        if (broken || capturing) return
        if (!host.isShown || host.width <= 0 || host.height <= 0) return
        val now = SystemClock.uptimeMillis()
        if (now - lastAt < intervalMs) return
        lastAt = now
        val started = now
        try {
            capture()
            // ★ 自适应节流：抓一次不许占掉太多时间。慢机器上自动降到 2 次/秒左右，
            //   宁可背景旧一点，也不能把滚动拖卡。
            intervalMs = ((SystemClock.uptimeMillis() - started) * 10)
                .coerceIn(BASE_INTERVAL_MS, MAX_INTERVAL_MS)
        } catch (_: Throwable) {
            // 同上：只丢引用，不 recycle
            broken = true
            bitmap.value = null
            canvas = null
        }
    }

    private fun capture() {
        // ★ 用 `rootView`（公开 API）：`View.getWindow()` 不是公开 API，Kotlin 编不过
        val root: View = host.rootView
        val hide = hostToHide(root) ?: return

        val w = max(1, ((host.width + marginPx * 2) / scale).toInt())
        val h = max(1, ((host.height + marginPx * 2) / scale).toInt())

        var bmp = bitmap.value
        if (bmp == null || bmp.width != w || bmp.height != h) {
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.value = bmp
            canvas = android.graphics.Canvas(bmp)
        }
        val c = canvas ?: return
        c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR)

        // 自己在窗口里的位置，换算成**相对 rootView 左上角**的偏移
        val loc = IntArray(2)
        val rootLoc = IntArray(2)
        host.getLocationInWindow(loc)
        root.getLocationInWindow(rootLoc)
        val dx = (loc[0] - rootLoc[0]).toFloat()
        val dy = (loc[1] - rootLoc[1]).toFloat()

        val previous = hide.visibility
        val others = hiddenSiblings(hide)
        capturing = true
        hide.visibility = View.INVISIBLE
        others.forEach { it.visibility = View.INVISIBLE }
        try {
            val save = c.save()
            c.scale(1f / scale, 1f / scale)
            // ★ 抓到的是 `[-margin, size+margin]` 这一圈，所以整体往左上挪 margin
            c.translate(-dx - marginPx, -dy - marginPx)
            root.draw(c)
            c.restoreToCount(save)
        } finally {
            others.forEach { it.visibility = View.VISIBLE }
            hide.visibility = previous
            capturing = false
        }
    }

    /**
     * 找出**该临时藏起来的那一层**。
     *
     * ★ 必须把"玻璃上面的内容"（Tab 文字、那颗滑动的胶囊）一起藏掉：
     *   只藏玻璃自己的话，它们会被抓进背景、糊一遍再画一遍 ——
     *   玻璃里会留一层糊掉的鬼影；而且玻璃自己也会被抓进去，
     *   **自己的输出当下一次的输入，越叠越糊**。
     *
     * ★ 尺寸**必须跟我们一样**：沿父链一直往上，直到某一层变大为止。
     *   玻璃是 `position: absolute; inset: 0`，所以从玻璃往上到 GlassBox 胶囊、
     *   再到外面几层纯包装，尺寸全都一样；再往上（tabBarWrap）就是整屏宽了。
     *
     * ★ 保险：**整屏那么大的层不藏**（藏了背景就空了，宁可退回近似）。
     */
    private fun hostToHide(root: View): View? {
        var found: View? = null
        var node = host.parent as? View
        var level = 0
        while (node != null && level < 8) {
            if (node.width != host.width || node.height != host.height) break
            if (root.width > 0 && root.height > 0 &&
                node.width >= root.width * 9 / 10 && node.height >= root.height * 9 / 10
            ) {
                break
            }
            found = node
            node = node.parent as? View
            level++
        }
        return found
    }

    /**
     * 另外还要藏掉**别的玻璃层**。
     *
     * ★ 选中胶囊就压在整条上面：胶囊抓背景时，整条那颗玻璃还在它背后 ——
     *   不藏的话胶囊会采到"已经糊过一遍的玻璃"，颜色叠两层，越看越脏。
     *   所以抓的时候把注册表里其它玻璃**全部**临时藏掉。
     *   （跟自己同层的那个由 `hostToHide` 负责，这里不重复处理。）
     */
    private fun hiddenSiblings(self: View): List<View> =
        Registry.snapshot().filter { it !== self && it.isShown }

    private companion object {
        /** 抓取间隔：约 8 次/秒 */
        const val BASE_INTERVAL_MS = 130L
        /** 慢机器上最多降到这个间隔（≈2 次/秒） */
        const val MAX_INTERVAL_MS = 500L
    }
}

/** 活着的玻璃视图登记处 —— 抓背景时要互相避开（见 `hiddenSiblings`） */
internal object Registry {
    private val views = mutableSetOf<View>()
    fun add(v: View) = views.add(v)
    fun remove(v: View) = views.remove(v)
    fun snapshot(): List<View> = views.toList()
}

/**
 * Kyant 材质的实际绘制。
 *
 * 结构就三样东西，跟库里 `LiquidBottomTabs` 那个示例一致：
 *
 *   `vibrancy()`  → 抬饱和度（真玻璃会把背后的颜色"滤"得更浓）
 *   `blur()`      → `RenderEffect` 的 GPU 模糊（API 31+）
 *   `lens()`      → 圆角矩形的 **SDF 折射**：越靠边采样点越往外拉，
 *                   边上被压缩 / 放大 —— 就是玻璃边缘那一圈折光（API 33+）
 *
 * ★★ `padding` 这个值必须算准，否则位图会错位：
 *
 *   `blur()` 只在**已经有 renderEffect 时**才把 `padding` 撑到 `radius`
 *   （见库里 `Blur.kt`：`if (edgeTreatment != Clamp || renderEffect != null)`）。
 *   所以调用顺序必须是 **先 `vibrancy()` 再 `blur()`** —— 反过来的话
 *   `padding` 是 0，材质层跟视图一样大，模糊就**采不到边界外的背景**，
 *   边上会糊出一圈自己的边缘色。接着 `lens()` 会把 `padding` 收掉
 *   `refractionHeight`，所以最终：
 *
 *       padding = max(0, blurRadius - refractionHeight)
 *
 *   材质层因此是 `size + 2*padding`、原点在 `-padding`；而 `BackdropCapture`
 *   抓的位图正好覆盖 `[-padding, size+padding]` —— 两边对齐，
 *   `dstOffset` 用 `-padding`、`dstSize` 用 `size + 2*padding` 就是严丝合缝。
 *
 * ★ 两个效果各自检查系统支持（`isRenderEffectSupported` / `isRuntimeShaderSupported`），
 *   不支持的机器上静默不生效 —— 那时还剩 `vibrancy` + 表面填充，是一块"平"的
 *   玻璃，但绝不花屏。调用方（`KyantGlassView`）另外用 `SDK_INT >= 33`
 *   把整条路挡在外面，只有真能出效果才走。
 */
@Composable
fun KyantGlass(
    backdrop: State<Bitmap?>,
    /**
     * 圆角，**用 `Dp` 传**。
     *
     * ★ 不能用 `RoundedCornerShape(px: Float)` 那个重载 —— 它是**百分比**
     *   （0~100），不是像素，传 100 会变成"圆角 100%"。走 `Dp` 那条才是
     *   我们想要的：`lens()` 会 `toPx()` 再按短边夹一下，胶囊（999dp）
     *   自然就被夹成半圆了。
     */
    cornerRadius: Dp,
    light: Boolean,
    blurRadiusPx: Float,
    refractionHeightPx: Float,
    refractionAmountPx: Float,
    /**
     * 材质层要往外扩多少像素（`padding`），由调用方算好。
     *
     * ★ 这里**不依赖上面两个效果自己算**：`blur()` 只在已经有 renderEffect 时
     *   才撑 padding，`lens()` 又把它收掉 —— 按示例那组参数（blur 8dp /
     *   lens 24dp）算出来是 **0**。0 就意味着材质层跟视图一样大，
     *   模糊**采不到边界外的背景**，边上会把自己边缘的颜色往里拖。
     *   所以最后显式赋一个值，把它撑开（见 `KyantGlassView` 里的 `PADDING_DP`）。
     */
    paddingPx: Float,
    modifier: Modifier = Modifier,
) {
    val shape = remember(cornerRadius) { RoundedCornerShape(cornerRadius) }

    /**
     * ★ `rememberCanvasBackdrop` 按 `onDraw` 的**引用**做 key —— 每次重组都
     *   新建 lambda 会让它每帧重建。所以 lambda 只依赖稳定的 `backdrop`（State）
     *   和 `paddingPx`，不直接闭包任何会变的值。
     */
    val pad = paddingPx.toInt()
    val draw: DrawScope.() -> Unit = remember(backdrop, pad) {
        {
            val bmp = backdrop.value
            if (bmp != null && !bmp.isRecycled) {
                val img = bmp.asImageBitmap()
                drawImage(
                    image = img,
                    srcOffset = IntOffset.Zero,
                    srcSize = IntSize(img.width, img.height),
                    // 位图覆盖视图坐标的 `[-padding, size+padding]`；
                    // 材质层的绘制原点也在 `-padding`（见库里 DrawBackdropModifier
                    // 的 `recordBackdropBlock` + `layer.topLeft`），所以整体挪 -pad
                    dstOffset = IntOffset(-pad, -pad),
                    dstSize = IntSize(
                        size.width.toInt() + pad * 2,
                        size.height.toInt() + pad * 2,
                    ),
                )
            }
        }
    }
    val canvasBackdrop = rememberCanvasBackdrop(draw)

    Box(
        modifier
            .fillMaxSize()
            /*
             * ★★ 这一行 `clip(shape)` **不能省** —— 少了它，玻璃会画成一整块**矩形**
             *    （表现为 Tab 栏底下露出一条灰条，四角从圆角外戳出来）。
             *
             *   为什么库自己不裁：`drawBackdrop` 的形状裁剪只作用在**内容**上
             *   （`DrawBackdropNode.MeasureScope.measure` 里那个
             *   `placeable.placeWithLayer(layerBlock = { clip = true; shape = ... })`），
             *   而**背景层**是 `drawLayer(graphicsLayer)` 直接画进当前画布的 ——
             *   它**完全不裁**（`internal/LayerRecorder.kt` 的 `recordLayer` 只做录制，
             *   没有任何 outline / clip）。
             *
             *   叠加我们自己把材质层往外扩了 `padding`（见下面参数），
             *   那个矩形比视图还大一圈 —— 所以必须在**自己这一层**把形状裁上。
             */
            .clip(shape)
            .drawBackdrop(
                backdrop = canvasBackdrop,
                shape = { shape },
                effects = {
                    // ★ 顺序有讲究：`vibrancy()` 先给 `renderEffect` 建出底，
                    //   后面 `blur()` 才是"往已有的 renderEffect 上再包一层"
                    //   （见库里 `ColorFilter.kt` / `Blur.kt`）
                    vibrancy()
                    blur(blurRadiusPx)
                    lens(refractionHeightPx, refractionAmountPx)
                    // ★ 必须**最后**赋：上面两个效果算出来的往往是 0（见参数说明），
                    //   撑开之后材质层 = `size + 2*padding`、原点在 `-padding`，
                    //   跟 `BackdropCapture` 抓的那块区域严丝合缝。
                    padding = paddingPx
                },
                // 表面那层很淡的底色：玻璃总得有一点自己的"体"
                onDrawSurface = {
                    drawRect(
                        if (light) Color.White.copy(alpha = 0.10f)
                        else Color.Black.copy(alpha = 0.10f)
                    )
                },
            )
    )
}
