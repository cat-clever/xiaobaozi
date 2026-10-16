package com.baozivideo

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.baozivideo.cast.CastPackage
import com.baozivideo.glass.GlassPackage
import com.baozivideo.media.MediaServerPackage
import com.baozivideo.screen.ScreenControlPackage
import com.baozivideo.updater.UpdaterPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 自动链接扫不到 App 自己的原生模块，手工注册
          add(MediaServerPackage())
          add(ScreenControlPackage())
          add(GlassPackage())
          add(CastPackage())
          add(UpdaterPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
