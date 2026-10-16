package com.baozivideo.cast

import android.content.Context
import android.net.wifi.WifiManager
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException

/**
 * SSDP 组播发现（Android）。
 *
 * ★★ 原生**只做这一件事**：发 M-SEARCH、收响应、把 `LOCATION` 那一行交回 JS。
 *   设备描述怎么解析、`AVTransport` 怎么找、SOAP 怎么发，**全在 TS**
 *   （`src/cast/dlna.ts`）—— 跟文档 §6.3「协议逻辑一律留在 TS」同一个原则，
 *   也让这套东西能在 vitest 里单测。
 *
 * ★★ **校验一律从宽**（用户 2026-10-16 的硬要求：「最宽松校验，省的无法投屏在电视上」）：
 *   · 不按 `ST` / `USN` / `Server` 过滤 —— 只要回包里**有 `LOCATION` 就收**
 *     （国产电视的 UPnP 实现五花八门，按规范卡会漏掉一大片）
 *   · 一次发**三个** `ST`：MediaRenderer / AVTransport / `ssdp:all`，
 *     并且**重复发四轮** —— 组播包丢得厉害，只发一次经常什么都收不到
 *   · 两个 socket 一起收：
 *       ① 临时端口那个 —— 收**单播**响应（UPnP 规范要求回给 M-SEARCH 的源地址）
 *       ② 绑 1900 并加入组播组那个 —— 收**组播**响应（不合规但真实存在的设备）
 *     ② 绑不上（端口被占）就跳过，不影响 ①
 *
 * ★ `WifiManager.MulticastLock` 必须拿：不拿的话 Wi-Fi 芯片会把组播包丢掉，
 *   ② 那个 socket 基本收不到东西（需要清单里的 `CHANGE_WIFI_MULTICAST_STATE`）。
 */
class SsdpModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "Ssdp"

    /**
     * 发现局域网里的设备。**不会 reject** —— 收不到就回空数组，
     * 让 UI 去说"未发现设备"，而不是抛一个用户看不懂的错。
     */
    @ReactMethod
    fun discover(timeoutMs: Double, promise: Promise) {
        Thread {
            val hits = try {
                SsdpDiscovery.run(ctx, timeoutMs.toLong())
            } catch (_: Throwable) {
                emptyList()
            }
            val array = Arguments.createArray()
            for (hit in hits) {
                array.pushMap(
                    Arguments.createMap().apply {
                        putString("location", hit.location)
                        putString("usn", hit.usn)
                        putString("st", hit.st)
                        putString("server", hit.server)
                        putString("address", hit.address)
                    }
                )
            }
            promise.resolve(array)
        }.start()
    }

    companion object {
        const val NAME = "Ssdp"
    }
}

/** 一条 SSDP 响应。`location` 是唯一的去重键，也是后面拉设备描述的入口 */
data class SsdpHit(
    val location: String,
    val usn: String,
    val st: String,
    val server: String,
    /** 回包来源的 IP —— 描述里拿不到 `friendlyName` 时拿它兜底显示 */
    val address: String,
)

object SsdpDiscovery {

    private const val GROUP = "239.255.255.250"
    private const val PORT = 1900

    /**
     * 三个都发。`ssdp:all` 会带回路由器之类的非媒体设备 —— **故意留着**：
     * TS 那边靠"描述里有没有 AVTransport"来筛，比在这儿按 `ST` 猜准得多。
     */
    private val TARGETS = listOf(
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "urn:schemas-upnp-org:service:AVTransport:1",
        "ssdp:all",
    )

    /** 组播丢包厉害，同一个搜索重复发几轮 */
    private const val ROUNDS = 4
    /** 收包阻塞的超时 —— 用来把"等 4 秒"切成一小段一小段，好按时发下一轮 */
    private const val RECV_TIMEOUT_MS = 350

    fun run(context: Context, timeoutMs: Long): List<SsdpHit> {
        val found = LinkedHashMap<String, SsdpHit>() // key = location
        val wifi = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = try {
            wifi?.createMulticastLock("baozivideo-ssdp")?.apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (_: Throwable) {
            null
        }

        var unicast: DatagramSocket? = null
        var group: MulticastSocket? = null
        try {
            unicast = openUnicast()
            group = openGroup()
            val mSearch = buildSearch()
            val target = InetAddress.getByName(GROUP)

            val deadline = SystemClock.uptimeMillis() + timeoutMs
            var round = 0
            val buffer = ByteArray(4096)

            while (SystemClock.uptimeMillis() < deadline) {
                if (round < ROUNDS) {
                    send(unicast, mSearch, target)
                    group?.let { send(it, mSearch, target) }
                    round++
                }
                drain(unicast, buffer, found)
                group?.let { drain(it, buffer, found) }
            }
        } catch (_: Throwable) {
            // 整个发现过程出问题也照样把已经收到的交回去
        } finally {
            try {
                unicast?.close()
            } catch (_: Throwable) {
            }
            try {
                group?.close()
            } catch (_: Throwable) {
            }
            try {
                lock?.release()
            } catch (_: Throwable) {
            }
        }
        return found.values.toList()
    }

    /** 临时端口，收**单播**响应 —— 绝大多数设备走这条 */
    private fun openUnicast(): DatagramSocket =
        DatagramSocket(null).apply {
            reuseAddress = true
            bind(InetSocketAddress(0))
            soTimeout = RECV_TIMEOUT_MS
        }

    /** 绑 1900 并加入组播组，收**组播**响应 —— 不合规但真实存在的设备走这条 */
    private fun openGroup(): MulticastSocket? = try {
        MulticastSocket(null).apply {
            reuseAddress = true
            bind(InetSocketAddress(PORT))
            soTimeout = RECV_TIMEOUT_MS
            joinGroup(InetAddress.getByName(GROUP))
        }
    } catch (_: Throwable) {
        null
    }

    private fun buildSearch(): ByteArray {
        val head = buildString {
            append("M-SEARCH * HTTP/1.1\r\n")
            append("HOST: $GROUP:$PORT\r\n")
            append("MAN: \"ssdp:discover\"\r\n")
            append("MX: 2\r\n")
            append("ST: ")
        }
        // 三个 ST 各发一包，拼成一个数组省一次循环
        return TARGETS.joinToString("") { "$head$it\r\n\r\n" }.toByteArray(Charsets.UTF_8)
    }

    /** 一次可能发了三个 M-SEARCH，所以要拆成三包分别发 */
    private fun send(socket: DatagramSocket, payload: ByteArray, target: InetAddress) {
        val text = String(payload, Charsets.UTF_8)
        for (chunk in text.split("\r\n\r\n")) {
            if (chunk.isBlank()) continue
            val bytes = (chunk + "\r\n\r\n").toByteArray(Charsets.UTF_8)
            try {
                socket.send(DatagramPacket(bytes, bytes.size, InetSocketAddress(target, PORT)))
            } catch (_: Throwable) {
                // 单个包发失败不致命，下一轮还有机会
            }
        }
    }

    /** 把 socket 里已经排队的包全收完（收到超时就返回，交给外层决定要不要再发一轮） */
    private fun drain(socket: DatagramSocket, buffer: ByteArray, out: MutableMap<String, SsdpHit>) {
        while (true) {
            val packet = DatagramPacket(buffer, buffer.size)
            try {
                socket.receive(packet)
            } catch (_: SocketTimeoutException) {
                return
            } catch (_: Throwable) {
                return
            }
            parse(packet)?.let { out[it.location] = it }
        }
    }

    /**
     * 解析一条响应。
     *
     * ★★ **只看 `LOCATION`** —— 没有它这条回包对我们毫无用处，有它就收。
     *   `USN` / `ST` / `SERVER` 拿不到就给空串，不因为缺字段丢掉设备。
     * ★ HTTP 头名**大小写不敏感**（有的设备写 `Location`、有的写 `LOCATION`），
     *   而且有的设备在头名前后带空格 —— 一并处理。
     */
    private fun parse(packet: DatagramPacket): SsdpHit? {
        val text = String(packet.data, 0, packet.length, Charsets.ISO_8859_1)
        if (!text.startsWith("HTTP/1.", ignoreCase = true)) return null

        var location = ""
        var usn = ""
        var st = ""
        var server = ""
        for (raw in text.split("\r\n")) {
            val idx = raw.indexOf(':')
            if (idx <= 0) continue
            val name = raw.substring(0, idx).trim().lowercase()
            val value = raw.substring(idx + 1).trim()
            when (name) {
                "location" -> if (location.isEmpty()) location = value
                "usn" -> usn = value
                "st" -> st = value
                "server" -> server = value
            }
        }
        if (location.isEmpty()) return null
        return SsdpHit(
            location = location,
            usn = usn,
            st = st,
            server = server,
            address = packet.address?.hostAddress.orEmpty(),
        )
    }
}
