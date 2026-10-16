package com.baozivideo.screen

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.os.Build
import android.util.Rational
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 播放页要用的少量系统能力：屏幕亮度、屏幕方向。
 *
 * ★ 单独立一个模块，不塞进 `MediaServer` —— 那边只管取流，两件事混在一起以后不好维护。
 * 两个方法都是尽力而为：拿不到 Activity（比如 App 在后台）就静默返回，不抛错。
 */
class ScreenControlModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = NAME

    /** value 取值 0..1（0 最暗）。Android 上 0 是"跟系统走"，所以下限抬到 0.01 */
    /**
     * ★ 用 `reactApplicationContext.currentActivity`，不要用 `currentActivity`。
     *   RN 0.80 起 `ReactContextBaseJavaModule` 改成了 Kotlin 版，原来的
     *   `getCurrentActivity()` 是**方法**（且已废弃），不是属性 ——
     *   Kotlin 里写 `currentActivity` 会 Unresolved reference。
     */
    private val activityOrNull: Activity?
        get() = reactApplicationContext.currentActivity

    @ReactMethod
    fun setBrightness(value: Double, promise: Promise) {
        val activity = activityOrNull
        if (activity == null) {
            promise.resolve(null)
            return
        }
        val clamped = value.coerceIn(0.01, 1.0).toFloat()
        activity.runOnUiThread {
            try {
                val params = activity.window.attributes
                params.screenBrightness = clamped
                activity.window.attributes = params
            } catch (_: Exception) {
                // 忽略
            }
        }
        promise.resolve(null)
    }

    /** 'landscape' / 'portrait' / 'auto' */
    @ReactMethod
    fun setOrientation(mode: String, promise: Promise) {
        val activity: Activity? = activityOrNull
        if (activity == null) {
            promise.resolve(null)
            return
        }
        // ★ 用固定的 LANDSCAPE 而不是 SENSOR_LANDSCAPE ——
        //   后者跟随重力感应，手机端得比较平时可能不转，看着像"按钮没反应"
        val requested = when (mode) {
            "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        activity.runOnUiThread {
            try {
                activity.requestedOrientation = requested
            } catch (_: Exception) {
                // 忽略
            }
        }
        promise.resolve(null)
    }

    /**
     * 按**视频的宽高比**设置画中画窗口。
     *
     * ★ 为什么要有这个方法：react-native-video 只在**手动**调
     *   `enterPictureInPictureMode()`（而且得 `STATE_READY`）时才 `setAspectRatio`；
     *   而上滑回桌面走的是 `setAutoEnterEnabled` 那条**自动进入**的路，
     *   它只设了 autoEnter、**没设比例** —— 于是画中画窗口用默认形状，
     *   视频两侧留白。
     *
     *   这里在视频元数据到手后按真实宽高比重设一次参数。
     *   注意 `setPictureInPictureParams` 是**替换**语义，会覆盖 RNV 之前设的
     *   （包括它在画中画里加的那个播放/暂停按钮，换成系统默认的展开/关闭）。
     *   取舍是"比例正确"优先 —— 比例不对是一眼就能看出来的毛病。
     */
    @ReactMethod
    fun setPipAspectRatio(width: Double, height: Double, promise: Promise) {
        val activity = activityOrNull
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            promise.resolve(null)
            return
        }
        activity.runOnUiThread {
            try {
                var w = width.toInt().coerceAtLeast(1)
                var h = height.toInt().coerceAtLeast(1)
                // 系统要求画中画比例落在 2.39:1 ~ 1:2.39 之间
                val ratio = w.toDouble() / h.toDouble()
                if (ratio > 2.39) {
                    w = 239; h = 100
                } else if (ratio < 1 / 2.39) {
                    w = 100; h = 239
                }

                val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(w, h))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // 保证"上滑回桌面自动进画中画"照样生效
                    builder.setAutoEnterEnabled(true)
                }
                activity.setPictureInPictureParams(builder.build())
            } catch (_: Exception) {
                // 没进过画中画 / 设备不支持都不该崩，静默跳过
            }
        }
        promise.resolve(null)
    }

    companion object {
        const val NAME = "ScreenControl"
    }
}
