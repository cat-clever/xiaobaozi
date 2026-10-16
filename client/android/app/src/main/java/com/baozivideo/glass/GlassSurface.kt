package com.baozivideo.glass

/**
 * 两种玻璃实现（`GlassView` 自绘 / `KyantGlassView` Compose）共用的口子。
 *
 * ★ 存在的意义：`GlassViewManager` 按系统版本二选一，但它只认这一个接口 ——
 *   RN 侧传的 `cornerRadius` / `glassStyle` 两边语义完全一致，
 *   换实现不影响任何 JS 代码。
 */
interface GlassSurface {
    /** 圆角，RN 侧传进来 */
    var cornerRadius: Float
    /** "dark" / "light" —— 决定用哪套材质 */
    var glassStyle: String
}
