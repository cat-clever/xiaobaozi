package com.baozivideo.updater

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 端内升级（Android）。
 *
 * 三件事：
 *   1. `getVersion` —— 告诉 JS 本机装的是哪一版（拿它跟更新清单比）
 *   2. `downloadAndInstall` —— 把 APK 下到 `cacheDir/updater/`，边下边发进度，下完交给系统安装器
 *   3. 报告进度（`updaterProgress` 事件）
 *
 * ★★ 这套在 Android 上能成立的前提是 **APK 签名固定** —— 密钥随仓库提交
 *   （`android/key.properties` + `app/xiaobaozi-release.p12`），所以新包能
 *   覆盖安装旧包、用户数据都留着。签名一变，用户就只能先卸载重装。
 *
 * ★ 只做"下载 + 交给系统安装器"，**不静默安装** —— 静默安装要么要 root，
 *   要么要设备管理员的权限，普通应用拿不到，也不该去拿。
 */
class UpdaterModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = NAME

    private val executor = Executors.newSingleThreadExecutor()

    /** APK 落这儿；`res/xml/file_paths.xml` 配的也是这一段 */
    private val apkDir: File
        get() = File(reactContext.cacheDir, "updater").apply { if (!exists()) mkdirs() }

    /** 本机版本。JS 侧拿它跟清单里的 versionCode 比 */
    @ReactMethod
    fun getVersion(promise: Promise) {
        try {
            val info = reactContext.packageManager.getPackageInfo(reactContext.packageName, 0)
            val map = Arguments.createMap()
            map.putString("versionName", info.versionName ?: "")
            map.putInt("versionCode", readVersionCode(info))
            map.putString("packageId", reactContext.packageName)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("E_VERSION", e.message ?: "读不到版本号", e)
        }
    }

    /**
     * 下载并交给系统安装器。
     *
     * ★ 没给「安装未知应用」权限时不直接失败：先把用户送到那个设置页，
     *   同时 reject 一个 JS 认得的 `NEED_PERMISSION`，界面上提示"回来再点一次"。
     */
    @ReactMethod
    fun downloadAndInstall(url: String, promise: Promise) {
        if (url.isBlank()) {
            promise.reject("E_URL", "下载地址为空")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !reactContext.packageManager.canRequestPackageInstalls()
        ) {
            openUnknownSourcesSettings()
            promise.reject("NEED_PERMISSION", "需要先允许安装未知应用")
            return
        }

        executor.execute {
            try {
                val file = download(url)
                launchInstaller(file)
                promise.resolve(file.absolutePath)
            } catch (e: Exception) {
                promise.reject("E_DOWNLOAD", e.message ?: "下载失败", e)
            }
        }
    }

    // ---------------- 内部 ----------------

    @Suppress("DEPRECATION")
    private fun readVersionCode(info: android.content.pm.PackageInfo): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode.toInt()
        } else {
            info.versionCode
        }

    /** 边下边发进度；文件名固定，重下直接覆盖，不堆垃圾 */
    private fun download(rawUrl: String): File {
        val out = File(apkDir, "xiaobaozi-update.apk")
        if (out.exists()) out.delete()

        val conn = URL(rawUrl).openConnection() as HttpURLConnection
        try {
            // ★ 必须自动跟随重定向：GitHub 的 release 直链会 302 到 CDN
            conn.instanceFollowRedirects = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Accept", "application/octet-stream")
            conn.connect()

            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")

            val total = conn.contentLengthLong
            FileOutputStream(out).use { fos ->
                conn.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    var received = 0L
                    var lastPercent = Int.MIN_VALUE
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        fos.write(buf, 0, read)
                        received += read
                        // 只在百分比变化时发事件：55MB 会读 800 多次，
                        // 每次都发会把 JS 线程淹掉
                        val percent =
                            if (total > 0) ((received * 100) / total).toInt() else -1
                        if (percent != lastPercent) {
                            lastPercent = percent
                            emitProgress(received, total)
                        }
                    }
                }
                fos.flush()
            }
        } finally {
            conn.disconnect()
        }

        if (out.length() <= 0L) throw IllegalStateException("下载到的文件是空的")
        return out
    }

    private fun emitProgress(received: Long, total: Long) {
        try {
            val params = Arguments.createMap()
            params.putDouble("received", received.toDouble())
            params.putDouble("total", total.toDouble())
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(PROGRESS_EVENT, params)
        } catch (_: Exception) {
            // 进度发不出去不影响下载本身
        }
    }

    /**
     * 交给系统安装器。
     *
     * ★ 必须走 FileProvider（`content://`）：Android 7 起把 `file://` 交给别的
     *   应用会直接抛 `FileUriExposedException`。authority 与清单里的
     *   `${applicationId}.updater` 是同一个（运行时就是 `packageName`）。
     * ★ `FLAG_GRANT_READ_URI_PERMISSION` 不能少 —— 安装器要读这个文件。
     */
    private fun launchInstaller(file: File) {
        val authority = reactContext.packageName + ".updater"
        val uri = FileProvider.getUriForFile(reactContext, authority, file)

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        val activity = reactContext.currentActivity
        if (activity != null) {
            activity.runOnUiThread { activity.startActivity(intent) }
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
        }
    }

    /** 送到「安装未知应用」那一页。有些定制 ROM 没有这一页，忽略即可 */
    private fun openUnknownSourcesSettings() {
        try {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + reactContext.packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
        } catch (_: Exception) {
            // 忽略
        }
    }

    companion object {
        const val NAME = "Updater"

        /** 下载进度事件名（与 JS 侧 `UPDATE_PROGRESS_EVENT` 一致） */
        const val PROGRESS_EVENT = "updaterProgress"
    }
}
