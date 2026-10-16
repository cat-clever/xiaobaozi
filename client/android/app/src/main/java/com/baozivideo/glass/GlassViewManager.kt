package com.baozivideo.glass

import android.view.View
import com.baozivideo.glass.kyant.KyantGlassView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * 玻璃视图的 RN 入口。**同一个名字（`GlassView`），底下两套实现**。
 *
 * ★★ 按系统版本二选一（2026-10-16）：
 *
 *   | | 谁画 | 怎么画 |
 *   | :--- | :--- | :--- |
 *   | **API 33+** | `KyantGlassView`（Compose + Kyant `backdrop`） | 抓背景 → `RenderEffect` 模糊 → 运行时着色器做 SDF 折射 |
 *   | **API 24 ~ 32** | `GlassView`（自绘） | 抓背景 → CPU 箱式模糊 → `drawBitmapMesh` 网格折射 |
 *
 *   为什么分档：Kyant 那套的折射要 `RuntimeShader`（33+）、模糊要 `RenderEffect`
 *   （31+），再往下它自己会静默降级成一块"平"玻璃 —— 还不如自绘那套
 *   （纯 CPU，全版本都能跑）。所以老的走老路，**不让老机器倒退**。
 *
 * ★ 两边都实现 `GlassSurface`，属性语义一模一样，所以 RN 侧（`GlassBox.tsx`）
 *   **一行都不用改** —— 它只认 `GlassView` 这个名字。
 */
class GlassViewManager : SimpleViewManager<View>() {

  override fun getName() = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): View =
    if (KyantGlassView.isSupported) KyantGlassView(reactContext)
    else GlassView(reactContext)

  @ReactProp(name = "cornerRadius", defaultFloat = 0f)
  fun setCornerRadius(view: View, radius: Float) {
    (view as GlassSurface).cornerRadius = radius
  }

  @ReactProp(name = "glassStyle")
  fun setGlassStyle(view: View, style: String?) {
    (view as GlassSurface).glassStyle = style ?: "dark"
  }

  companion object {
    const val NAME = "GlassView"
  }
}
