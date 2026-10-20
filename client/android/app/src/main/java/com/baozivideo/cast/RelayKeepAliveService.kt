package com.baozivideo.cast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.baozivideo.MainActivity
import com.baozivideo.R

/**
 * 转发投屏期间的保活服务。
 *
 * ★ 为什么需要它（2026-10-20 真机定位）：
 *   转发模式下流是从**手机里的本地媒体服务**出去的，电视只是来取流。
 *   手机息屏 / 切后台后，系统（尤其 MIUI）会把进程冻结 —— 内核里的监听
 *   socket 还在（电视能连上），但 accept 线程和 worker 全停了（一个字节都不回），
 *   电视的 ExoPlayer 等 8 秒超时，画面就冻在最后一帧。
 *
 *   前台服务让系统把进程当成"正在为用户干活"，不再冻结；PARTIAL_WAKE_LOCK
 *   保证息屏后 CPU 不会进 Doze，本地 HTTP 服务能继续应答。
 *
 * ★ 类型用 `mediaPlayback` 而不是 `dataSync`：
 *   - 语义上说得通：为远端播放器提供媒体
 *   - Android 15 起 dataSync 有每天 6 小时上限，追剧会被系统掐掉；mediaPlayback 没有
 *
 * ★ 生命周期由 JS 控制（`MediaServer.startRelayKeepAlive / stopRelayKeepAlive`），
 *   只在**转发模式**投屏期间开着；直投不需要（电视自己去 CDN 取）。
 */
class RelayKeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        try {
            // Android 8+ 必须在 5 秒内 startForeground，否则 ANR / 崩
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (_: Exception) {
            // 例如 Android 14+ 的类型限制、或后台启动被拒 —— 别留一个空服务
            stopSelf()
            return START_NOT_STICKY
        }

        if (wakeLock == null) {
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "baozivideo:cast-relay",
                ).apply {
                    setReferenceCounted(false)
                    acquire()
                }
            } catch (_: Exception) {
                // 拿不到唤醒锁就只靠前台服务 —— 比整个服务起不来强
            }
        }
        // 不自动重启：投屏是一次性会话，进程没了再起一个空服务没有意义。
        // 用户从最近任务划掉 App 时由清单里的 stopWithTask 跟着停，
        // 别留一个孤儿通知 + 唤醒锁。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        try {
            wakeLock?.release()
        } catch (_: Exception) {
            // 已经释放过
        }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "投屏转发",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "转发投屏期间保持后台取流"
                setShowBadge(false)
            },
        )
    }

    private fun buildNotification(): Notification {
        // 点通知回到 App —— 投屏遥控器在播放页里
        val open = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        // minSdk 24，FLAG_IMMUTABLE（API 23+）可以直接用
        val pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_cast_relay)
            .setContentTitle("正在投屏")
            .setContentText("电视正在通过本机取流，请保持网络连接")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pending)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "cast-relay"
        private const val NOTIFICATION_ID = 0x0B0A
    }
}
