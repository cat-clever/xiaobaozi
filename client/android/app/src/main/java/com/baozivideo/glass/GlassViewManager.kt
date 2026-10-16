package com.baozivideo.glass

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class GlassViewManager : SimpleViewManager<GlassView>() {

  override fun getName() = NAME

  override fun createViewInstance(reactContext: ThemedReactContext) = GlassView(reactContext)

  @ReactProp(name = "cornerRadius", defaultFloat = 0f)
  fun setCornerRadius(view: GlassView, radius: Float) {
    view.cornerRadius = radius
  }

  @ReactProp(name = "glassStyle")
  fun setGlassStyle(view: GlassView, style: String?) {
    view.glassStyle = style ?: "dark"
  }

  companion object {
    const val NAME = "GlassView"
  }
}
