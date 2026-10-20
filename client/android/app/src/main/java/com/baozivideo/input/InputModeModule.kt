package com.baozivideo.input

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * 输入方式（遥控器 / 触摸）上报。
 *
 * ★ 为什么要它：焦点环只在**遥控器介入**时显示。JS 侧靠这个事件切
 *   `remote` 标志 —— 触摸一下立刻置 false，焦点环马上消失；按方向键又置
 *   true。见 `MainActivity.dispatchKeyEvent / dispatchTouchEvent`。
 */
class InputModeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = NAME

    private fun emit(remote: Boolean) {
        if (!reactContext.hasActiveReactInstance()) return
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT, Arguments.createMap().apply { putBoolean("remote", remote) })
    }

    // NativeEventEmitter 在 Android 侧要求模块有这两个方法
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    override fun invalidate() {
        if (instance === this) instance = null
        super.invalidate()
    }

    companion object {
        const val NAME = "InputMode"
        private const val EVENT = "inputMode"

        @Volatile
        private var instance: InputModeModule? = null

        /** 由 Activity 调用；模块还没挂上就什么都不做 */
        fun note(remote: Boolean) {
            instance?.emit(remote)
        }
    }

    init {
        instance = this
    }
}
