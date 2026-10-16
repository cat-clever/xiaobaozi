package com.baozivideo.glass.kyant

import android.content.Context
import android.os.Build
import android.widget.FrameLayout
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import com.baozivideo.glass.GlassSurface

/**
 * Kyant `backdrop` 材质版的玻璃视图（Android）。
 *
 * ★ 它跟 `GlassView` **对外是同一个东西** —— 同样实现 `GlassSurface`、
 *   同样的 `cornerRadius` / `glassStyle`、同样只画不接（`isClickable = false`）。
 *   `GlassViewManager` 按系统版本二选一，RN 那边**完全不知道**底下换人了。
 *
 *   为什么不是"把整个 Tab 栏搬进 Compose"：Tab 栏那套（三个标签、滑动的胶囊、
 *   拖拽切 Tab、跟内容分页器同步）是 RN 侧的 `Animated.Value` 串起来的，
 *   搬进 Compose 就得把拖拽进度逐帧回传 JS —— 平白多一条桥，还更容易卡。
 *   这里只换**材质**：布局、动画、手势全留在 RN，两边各干各最擅长的事。
 *
 * ★ 内部就是一个 `ComposeView`，里面 `KyantGlass` 负责画：
 *   抓背景（`BackdropCapture`）→ `RenderEffect` 模糊 → SDF 折射 → 表面高光。
 *
 * ★ **只在 API 33+ 用**（见 `isSupported`）：折射要 `RuntimeShader`（33+）、
 *   模糊要 `RenderEffect`（31+），再往下这套材质会退化成一块平玻璃，
 *   还不如 `GlassView.kt` 那套自己算的箱式模糊 + 网格折射。
 */
class KyantGlassView(context: Context) : FrameLayout(context), GlassSurface {

    /** 抓到的背景。Compose 侧直接读它，抓到新的就自动重组 */
    private val capture = BackdropCapture(
        host = this,
        scale = CAPTURE_SCALE,
        marginPx = (PADDING_DP * resources.displayMetrics.density).toInt(),
    )

    private val density = resources.displayMetrics.density
    private val corner = androidx.compose.runtime.mutableStateOf(0f)
    private val light = androidx.compose.runtime.mutableStateOf(false)

    override var cornerRadius: Float
        get() = corner.value
        set(value) {
            corner.value = value
        }

    override var glassStyle: String
        get() = if (light.value) "light" else "dark"
        set(value) {
            light.value = value == "light"
        }

    init {
        // 普通 ViewGroup 子类默认不回调 onDraw；这里不需要自己画，但保持跟
        // `GlassView` 一致的行为（将来要在外层加东西也不会踩坑）
        setWillNotDraw(false)
        // ★ 只画不接：触摸穿透到下面的手势层 / 上面的按钮
        isClickable = false
        isFocusable = false

        addView(
            ComposeView(context).apply {
                setContent {
                    KyantGlass(
                        backdrop = capture.bitmap,
                        // RN 传的是**像素**，这里换成 dp 交给 Compose
                        cornerRadius = (corner.value / density).dp,
                        light = light.value,
                        blurRadiusPx = BLUR_DP * density,
                        refractionHeightPx = REFRACTION_HEIGHT_DP * density,
                        refractionAmountPx = REFRACTION_AMOUNT_DP * density,
                        paddingPx = PADDING_DP * density,
                    )
                }
            },
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        Registry.add(this)
        capture.attach()
    }

    override fun onDetachedFromWindow() {
        capture.detach()
        Registry.remove(this)
        super.onDetachedFromWindow()
    }

    companion object {

        /**
         * 这台机器能不能出 Kyant 那套材质。
         *
         * ★ 卡在 **33**：`lens()` 要 `RuntimeShader`（API 33），`blur()` 要
         *   `RenderEffect`（API 31）。两样都齐了才值得走这条路 ——
         *   缺一样就是一块"平"玻璃，还不如现有那套自绘的。
         */
        val isSupported: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

        /**
         * 参数照库里 `LiquidBottomTabs` 那个示例来（`blur(8dp)` + `lens(24dp)`），
         * 那是作者调好的观感。
         */
        private const val BLUR_DP = 8f
        private const val REFRACTION_HEIGHT_DP = 24f
        private const val REFRACTION_AMOUNT_DP = 24f

        /**
         * 材质层往外扩的一圈（`padding`）。
         *
         * ★ 必须**自己定**，不能让 `blur()` / `lens()` 算：按上面那组参数算出来是
         *   `max(0, 8 - 24) = 0`，而 0 意味着材质层跟视图一样大 ——
         *   模糊采不到边界外的背景，边上会把自己边缘的颜色往里拖。
         *   8dp 够糊开一圈，又不会把抓取区域撑得太大。
         */
        private const val PADDING_DP = 8f

        /**
         * 抓背景缩到 1/2。
         *
         * ★ 比 `GlassView` 那套（1/6）细得多：那边是**在 CPU 上**做箱式模糊，
         *   缩得越狠越快；这边模糊是 GPU 的 `RenderEffect`，抓取本身就便宜，
         *   缩太多反而喂给材质一张糊上加糊的图。
         */
        private const val CAPTURE_SCALE = 2f
    }
}
