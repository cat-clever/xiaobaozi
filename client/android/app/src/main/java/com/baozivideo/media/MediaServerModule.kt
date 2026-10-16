package com.baozivideo.media

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 本地媒体服务（Android 薄壳）。
 *
 * 只做四件事，**协议逻辑一律留在 TS**（见 `src/media/playlistRewriter.ts`）：
 *   1. 在回环地址上起一个 HTTP/1.1 服务
 *   2. 按会话注入请求头、透传 `Range` 去取上游
 *   3. 源1 主线路的 `wsSecret` **逐请求现算**（30 秒时效，没法预生成）
 *   4. 播放列表正文交给 JS 重写后再回给播放器
 *
 * 路由：`GET /m/<token>/<sid>/<b64url(原始地址)>/<文件名>`
 *   - token 一次性的，随服务启动生成，校验不过一律 403
 *   - 文件名保留原后缀，好让播放器按后缀选对管线（.m3u8 / .mp4 / .ts）
 */
class MediaServerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = NAME

    /**
     * 一次播放会话：注入哪些头、要不要逐请求签名。
     *
     * 后四个字段是 HEVC-TS 转封装用的（见 `prepareRemux`）—— iOS 那边同名同义。
     */
    private class Session(val headers: Map<String, String>, val sign: JSONObject?) {
        /** 非 null = 这条线路走转封装（只有探测确认是 HEVC-TS 才会建） */
        @Volatile
        var remuxer: TsFmp4Remuxer? = null

        /** `#EXT-X-MAP` 指向的初始化段 */
        @Volatile
        var remuxInit: ByteArray? = null

        /** 探测时已经转好的那一片（地址 + 字节），分片请求来了直接给，省一次往返 */
        @Volatile
        var probedTarget: String? = null

        @Volatile
        var probedData: ByteArray? = null

        /** 上一次探测还没回来 —— 别叠着探 */
        @Volatile
        var probing: Boolean = false

        /**
         * 转封装器**不是线程安全的**（分片序号、init 缓存都是有状态的），
         * 而播放器会预取、两片可能同时在转 —— 用这把锁串起来。
         */
        val remuxLock = Any()
    }

    /** 一个挂起中的播放列表请求，等 JS 把重写结果交回来 */
    private class Pending {
        val latch = CountDownLatch(1)

        @Volatile
        var body: String? = null
    }

    private var serverSocket: ServerSocket? = null
    private var token: String = ""
    private var port: Int = 0

    private val running = AtomicBoolean(false)
    private val sessions = ConcurrentHashMap<String, Session>()
    private val pending = ConcurrentHashMap<String, Pending>()
    private val requestSeq = AtomicInteger(0)
    private var pool: ExecutorService = Executors.newFixedThreadPool(MAX_WORKERS)

    // ---------------- 对 JS 暴露的接口 ----------------

    @ReactMethod
    fun start(promise: Promise) {
        if (running.get()) {
            promise.resolve(portInfo())
            return
        }
        try {
            // ★★ 有局域网就绑**所有网卡**（`0.0.0.0`），没有就只绑回环。
            //
            //   为什么（文档 §6.3 寻址策略）：投屏时电视要能取到流，而它取不到
            //   手机的 `127.0.0.1` —— 所以投屏地址必须是局域网地址。
            //   绑 `0.0.0.0` 之后**回环与局域网同时可达**：
            //   本地播放仍旧走回环（地址不变、行为不变），投屏才用局域网地址。
            //
            //   安全边界没松：随机端口 + 一次性 token 走 URL 路径
            //   （`/m/<token>/<sid>`），而且**只在播放/投屏期间存活**。
            //   `lanAddress()` 拿不到地址时老实退回只绑回环。
            val lan = lanAddress()
            val bindAddr = if (lan.isNotEmpty()) null else InetAddress.getByName(LOOPBACK)
            val socket = if (bindAddr == null) ServerSocket(0, BACKLOG)
            else ServerSocket(0, BACKLOG, bindAddr)
            serverSocket = socket
            port = socket.localPort
            token = UUID.randomUUID().toString().replace("-", "")
            if (pool.isShutdown) pool = Executors.newFixedThreadPool(MAX_WORKERS)
            running.set(true)

            Thread({ acceptLoop(socket) }, "baozivideo-media-accept").apply { isDaemon = true }.start()
            promise.resolve(portInfo())
        } catch (err: Exception) {
            promise.reject("media_server_start_failed", err)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        running.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {
            // 忽略
        }
        serverSocket = null
        sessions.clear()
        // 唤醒所有等 JS 回话的请求，别让它们吊死在超时上
        for (entry in pending.values) {
            entry.latch.countDown()
        }
        pending.clear()
        pool.shutdownNow()
        promise.resolve(null)
    }

    @ReactMethod
    fun createSession(sid: String, configJson: String, promise: Promise) {
        try {
            val config = JSONObject(configJson)
            val headers = HashMap<String, String>()
            config.optJSONObject("headers")?.let { obj ->
                for (key in obj.keys()) headers[key] = obj.optString(key)
            }
            val sign = if (config.isNull("sign")) null else config.optJSONObject("sign")
            sessions[sid] = Session(headers, sign)
            promise.resolve(null)
        } catch (err: Exception) {
            promise.reject("media_session_failed", err)
        }
    }

    /**
     * 探测这条线路要不要转封装，要的话**先转一片**把参数集拿到手。
     *
     * ★ 必须在**播放器取播放列表之前**调：`#EXT-X-MAP` 得写在播放列表里，
     *   而播放列表是播放器第一件事就去取的（JS 侧见 `MediaSession.prepareRemux`）。
     *
     * ★ 判定方式就是"转得动就转"：先只取**前 64KB**嗅 PAT/PMT，不是 HEVC 就此
     *   收手（H.264 才是绝大多数，不为它白下一整片）；是 HEVC 才整片取回来真转。
     *   任何一步不成一律回 `{remux:false}`（照常直通）。
     */
    @ReactMethod
    fun prepareRemux(sid: String, segmentUrl: String, promise: Promise) {
        val session = sessions[sid]
        if (session == null) {
            promise.resolve(remuxVerdict(false))
            return
        }
        if (session.probing || session.remuxer != null) {
            promise.resolve(remuxVerdict(session.remuxer != null))
            return
        }
        session.probing = true

        Thread {
            var ok = false
            try {
                ok = probeAndRemux(session, segmentUrl)
            } catch (_: Throwable) {
                ok = false
            } finally {
                session.probing = false
            }
            promise.resolve(remuxVerdict(ok))
        }.start()
    }

    /**
     * 取一段文本（走同一套头注入 + 逐请求现算签名），结果直接回给 JS。
     *
     * JS 侧用它取播放列表正文，好算出第一条分片的地址再交给 `prepareRemux` 探测。
     * 与 iOS 的 `fetchText` 同名同义。
     */
    @ReactMethod
    fun fetchText(sid: String, url: String, promise: Promise) {
        val session = sessions[sid]
        if (session == null) {
            promise.reject("media_session_missing", "会话不存在")
            return
        }
        if (!url.startsWith("http")) {
            promise.reject("media_bad_target", "地址不合法")
            return
        }
        Thread {
            val fetched = fetchUpstream(session, url, null)
            if (fetched == null || fetched.status !in 200..299) {
                promise.reject("media_fetch_failed", "取回失败")
            } else {
                promise.resolve(String(fetched.body, Charsets.UTF_8))
            }
        }.start()
    }

    /** 探测 + （是 HEVC 时）真转一片。返回是否启用转封装 */
    private fun probeAndRemux(session: Session, segmentUrl: String): Boolean {
        // ① 先要前 64KB —— PAT/PMT 就在 TS 最前面
        val head = fetchUpstream(session, segmentUrl, "bytes=0-${PROBE_BYTES - 1}") ?: return false
        if (head.body.isEmpty()) return false

        // ② 嗅编解码 —— 不是 HEVC 就此收手
        if (TsFmp4Remuxer.videoStreamType(head.body) != 0x24) return false

        // ③ 是 HEVC。手上这坨可能本来就是完整一片（服务器不认 Range 回了整片，
        //    或者这片本身就比探测长度小），那就直接转；否则整片再来一次
        val total = head.totalSize
        val complete = head.status == 200 || total == null || head.body.size.toLong() >= total
        if (complete && attemptRemux(session, head.body, segmentUrl)) return true

        val full = fetchUpstream(session, segmentUrl, null) ?: return false
        return attemptRemux(session, full.body, segmentUrl)
    }

    /**
     * 真转一次并把结果记到会话上。返回是否成功。
     *
     * ★ 转得动就转 —— HEVC + AAC 装在 TS 里才行，别的编码在这里抛异常，
     *   那条线路照常直通。
     */
    private fun attemptRemux(session: Session, data: ByteArray, target: String): Boolean {
        val remuxer = TsFmp4Remuxer()
        val fragment = try {
            remuxer.remux(data)
        } catch (_: Throwable) {
            return false
        }
        val initData = try {
            remuxer.initSegment()
        } catch (_: Throwable) {
            return false
        }
        synchronized(session.remuxLock) {
            session.remuxer = remuxer
            session.remuxInit = initData
            session.probedTarget = target
            session.probedData = fragment
        }
        return true
    }

    private fun remuxVerdict(remux: Boolean) = Arguments.createMap().apply {
        putBoolean("remux", remux)
    }

    /**
     * 取一段上游内容（注入会话头 + 逐请求现算签名），整段读回内存。
     *
     * ★ 转封装必须拿到**完整一片**（PES 要跨包重组、片尾那个 NAL 要等下一片的
     *   起始码才知道结束），所以不能像 `proxy` 那样边收边发。内存峰值 = 一片的
     *   大小（几百 KB ～ 1 MB 级），可以接受。
     */
    private class Upstream(val status: Int, val body: ByteArray, val totalSize: Long?)

    private fun fetchUpstream(session: Session, target: String, range: String?): Upstream? {
        val finalUrl = session.sign?.let { signUrl(target, it) } ?: target
        val conn = URL(finalUrl).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.instanceFollowRedirects = true
            for ((key, value) in session.headers) conn.setRequestProperty(key, value)
            if (!range.isNullOrEmpty()) conn.setRequestProperty("Range", range)
            conn.connect()

            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.readBytes() ?: ByteArray(0)
            // `Content-Range: bytes 0-65535/204732` 里的总长
            val totalSize = conn.getHeaderField("Content-Range")
                ?.substringAfterLast('/')
                ?.trim()
                ?.toLongOrNull()
            return Upstream(status, body, totalSize)
        } catch (_: Throwable) {
            return null
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 转封装会话取分片：整段取回 -> TS 转 fMP4 -> 发给播放器。
     *
     * ★ 与 iOS 的 `remux(target:session:...)` 同一套逻辑。
     */
    private fun remuxSegment(
        session: Session,
        target: String,
        range: String?,
        out: BufferedOutputStream,
    ) {
        val remuxer = session.remuxer
        if (remuxer == null) {
            writeSimple(out, 502, "Bad Gateway")
            return
        }

        // 探测时已经转好的那一片直接给（顺带省掉一次网络往返）
        if (session.probedTarget == target) {
            val probed = session.probedData
            if (probed != null) {
                writeBytes(out, probed)
                return
            }
        }

        val fetched = fetchUpstream(session, target, null)
        if (fetched == null || fetched.status !in 200..299) {
            writeSimple(out, 502, "Bad Gateway")
            return
        }

        // ★ 播放器会预取，两片可能同时在转 —— 转封装器不是线程安全的，串起来
        val fragment = synchronized(session.remuxLock) {
            try {
                remuxer.remux(fetched.body)
            } catch (_: Throwable) {
                null
            }
        }
        if (fragment == null) {
            writeSimple(out, 502, "Remux Failed")
            return
        }
        writeBytes(out, fragment)
    }

    /** 这条上游地址是不是播放列表（转封装只接媒体分片，播放列表照常走重写） */
    private fun isPlaylistUrl(target: String): Boolean =
        target.substringBefore('?').endsWith(".m3u8", ignoreCase = true) ||
            target.substringBefore('?').endsWith(".m3u", ignoreCase = true)

    /** 把一段字节按 mp4 发出去（转封装产物与 init 段都走这里） */
    private fun writeBytes(out: BufferedOutputStream, data: ByteArray) {
        writeHead(out, 200, "OK", "video/mp4", data.size.toLong(), null)
        out.write(data)
        out.flush()
    }

    @ReactMethod
    fun closeSession(sid: String, promise: Promise) {
        sessions.remove(sid)
        promise.resolve(null)
    }

    /** JS 把重写好的播放列表交回来，唤醒那个挂起的响应 */
    @ReactMethod
    fun respondPlaylist(reqId: String, text: String, promise: Promise) {
        pending[reqId]?.let {
            it.body = text
            it.latch.countDown()
        }
        promise.resolve(null)
    }

    // NativeEventEmitter 在 Android 侧要求模块有这两个方法（哪怕什么都不做）
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    override fun invalidate() {
        running.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {
            // 忽略
        }
        pool.shutdownNow()
        super.invalidate()
    }

    // ---------------- HTTP 服务 ----------------

    private fun portInfo() = Arguments.createMap().apply {
        putInt("port", port)
        putString("token", token)
        // ★ 局域网地址（拿不到就是空串，TS 侧会退回回环）
        putString("lanHost", lanAddress())
    }

    /**
     * 找一个**局域网** IPv4。
     *
     * ★ 优先 `wlan*` / `eth*`（真网卡），其次其它非回环网卡；跳过 `tun` / `ppp`
     *   （VPN 隧道的地址局域网里根本不可达，给了反而把投屏带沟里）。
     * ★ 排除 `169.254.*`（链路本地，没拿到 DHCP 时的兜底地址，不可用）。
     * ★ 出任何问题都回空串 —— 投屏用不了，但本地播放一点不受影响。
     */
    private fun lanAddress(): String {
        var preferred = ""
        var fallback = ""
        try {
            for (nif in java.util.Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp || nif.isLoopback) continue
                val name = nif.name.lowercase()
                if (name.startsWith("tun") || name.startsWith("ppp")) continue
                for (addr in java.util.Collections.list(nif.inetAddresses)) {
                    if (addr.isLoopbackAddress || addr !is Inet4Address) continue
                    val ip = addr.hostAddress ?: continue
                    if (ip.startsWith("169.254.")) continue
                    if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap")) {
                        if (preferred.isEmpty()) preferred = ip
                    } else if (fallback.isEmpty()) {
                        fallback = ip
                    }
                }
            }
        } catch (_: Throwable) {
            // 拿不到就当没有局域网
        }
        return if (preferred.isNotEmpty()) preferred else fallback
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get()) {
            val client = try {
                socket.accept()
            } catch (_: Exception) {
                break // socket 被关掉了
            }
            try {
                pool.execute { handle(client) }
            } catch (_: RejectedExecutionException) {
                try {
                    client.close()
                } catch (_: Exception) {
                    // 忽略
                }
            }
        }
    }

    private fun handle(client: Socket) {
        try {
            client.soTimeout = READ_TIMEOUT_MS
            val out = BufferedOutputStream(client.getOutputStream())
            val head = readHead(client.getInputStream())

            if (head == null) {
                writeSimple(out, 400, "Bad Request")
                return
            }

            val lines = head.split("\r\n")
            val parts = lines.firstOrNull()?.split(" ") ?: emptyList()
            if (parts.size < 2 || parts[0] != "GET") {
                writeSimple(out, 405, "Method Not Allowed")
                return
            }

            var range: String? = null
            for (line in lines.drop(1)) {
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Range", ignoreCase = true)) {
                    range = line.substring(idx + 1).trim()
                }
            }

            // 播放器偶尔会在地址后面挂 query（AVPlayer 就会）—— 先切掉再解析路径
            val segments = parts[1].substringBefore('?').trimStart('/').split("/")
            if (segments.size < 4 || segments[0] != ROUTE_PREFIX) {
                writeSimple(out, 404, "Not Found")
                return
            }
            if (segments[1] != token) {
                writeSimple(out, 403, "Forbidden")
                return
            }
            val session = sessions[segments[2]]
            if (session == null) {
                writeSimple(out, 404, "No Session")
                return
            }

            // 转封装会话的初始化分片（`#EXT-X-MAP` 指向它）：
            // `/m/<token>/<sid>/init.mp4` —— 比普通路由少一段，所以先判它
            if (segments.size == 4 && segments[3] == INIT_SEGMENT_NAME) {
                val initData = session.remuxInit
                if (initData == null) {
                    writeSimple(out, 404, "No Init Segment")
                    return
                }
                writeBytes(out, initData)
                return
            }

            if (segments.size < 5) {
                writeSimple(out, 404, "Not Found")
                return
            }
            val target = decodeBase64Url(segments[3])
            if (target == null || !target.startsWith("http")) {
                writeSimple(out, 400, "Bad Target")
                return
            }

            // 转封装会话的**媒体分片**：整段取回、转成 fMP4 再给（播放列表不走这里）
            if (session.remuxer != null && !isPlaylistUrl(target)) {
                remuxSegment(session, target, range, out)
                return
            }

            proxy(segments[2], target, session, range, out)
        } catch (_: Exception) {
            // 播放器随时会掐连接，这里不值得报错
        } finally {
            try {
                client.close()
            } catch (_: Exception) {
                // 忽略
            }
        }
    }

    /** 读到 `\r\n\r\n` 为止。请求头很小，超过上限就放弃 */
    private fun readHead(input: InputStream): String? {
        val buffer = ByteArrayOutputStream()
        var w0 = -1
        var w1 = -1
        var w2 = -1

        while (buffer.size() < MAX_HEAD_BYTES) {
            val b = input.read()
            if (b == -1) return null
            buffer.write(b)
            if (w0 == CR && w1 == LF && w2 == CR && b == LF) {
                return buffer.toString("ISO-8859-1")
            }
            w0 = w1
            w1 = w2
            w2 = b
        }
        return null
    }

    private fun proxy(
        sid: String,
        target: String,
        session: Session,
        range: String?,
        out: BufferedOutputStream,
    ) {
        // ★ 每次请求都现算签名 —— wsSecret 只有 30 秒时效
        val finalUrl = session.sign?.let { signUrl(target, it) } ?: target
        val conn = URL(finalUrl).openConnection() as HttpURLConnection

        try {
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.instanceFollowRedirects = true
            for ((key, value) in session.headers) conn.setRequestProperty(key, value)

            // ★ 播放列表**绝不能带 Range** —— 带了上游回 206 + 半截正文，
            //   重写出来就是个残缺的播放列表。按原地址的后缀先判一次。
            val looksPlaylistByUrl = target.substringBefore('?').endsWith(".m3u8", ignoreCase = true)
            if (!looksPlaylistByUrl && !range.isNullOrEmpty()) {
                conn.setRequestProperty("Range", range)
            }
            conn.connect()

            val status = conn.responseCode
            val contentType = conn.contentType ?: ""
            val looksPlaylist = looksPlaylistByUrl || contentType.contains("mpegurl", ignoreCase = true)

            if (looksPlaylist && status in 200..299) {
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val rewritten = askJsToRewrite(sid, target, text)
                val body = rewritten.toByteArray(Charsets.UTF_8)
                writeHead(out, 200, "OK", "application/vnd.apple.mpegurl", body.size.toLong(), null)
                out.write(body)
                out.flush()
                return
            }

            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            writeHead(
                out,
                status,
                "",
                contentType.ifEmpty { "application/octet-stream" },
                conn.getHeaderField("Content-Length")?.toLongOrNull(),
                conn.getHeaderField("Content-Range"),
            )
            if (stream != null) {
                val chunk = ByteArray(COPY_BUFFER)
                while (true) {
                    val read = stream.read(chunk)
                    if (read <= 0) break
                    out.write(chunk, 0, read)
                }
            }
            out.flush()
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 把播放列表正文交给 JS 重写。
     *
     * ★ 超时或 JS 报错一律**原样透传** —— 最坏结果是播放列表没被改写
     *   （源2 会被限速），但绝不能让播放器卡在"正在解析线路"上。
     */
    private fun askJsToRewrite(sid: String, url: String, text: String): String {
        val reqId = "r" + requestSeq.incrementAndGet()
        val entry = Pending()
        pending[reqId] = entry

        try {
            val params = Arguments.createMap().apply {
                putString("reqId", reqId)
                putString("sid", sid)
                putString("url", url)
                putString("text", text)
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(PLAYLIST_EVENT, params)

            return if (entry.latch.await(REWRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                entry.body ?: text
            } else {
                text
            }
        } catch (_: Exception) {
            return text
        } finally {
            pending.remove(reqId)
        }
    }

    // ---------------- 签名 ----------------

    /**
     * 现算 `wsSecret` 并拼进 query。
     *
     * 与 `参考/影视站api1.js` 的 `wsSecret()` / `signQuery()` 等价：
     *   `wsSecret = MD5(key + pathname + hex(ts))` 小写
     * `extra`（`ck` 解出来的 `k=..&Time=..&uid=..`）拼进 query 但**不参与** md5，
     * 少了它源站回 463（签名对但访问凭证缺）。
     *
     * 具体模板由 TS 下发（`src/media/segmentSigner.ts`），这里只是个字符串机器。
     */
    private fun signUrl(raw: String, sign: JSONObject): String {
        return try {
            val parsed = URL(raw)
            val path = parsed.path ?: ""
            val seconds = System.currentTimeMillis() / 1000
            val tsHex = java.lang.Long.toHexString(seconds)

            val input = sign.optString("template", "{key}{path}{tsHex}")
                .replace("{key}", sign.optString("key", ""))
                .replace("{path}", path)
                .replace("{tsHex}", tsHex)
                .replace("{ts}", seconds.toString())
            val secret = md5Hex(input)

            val drop = HashSet<String>()
            sign.optJSONArray("drop")?.let { arr ->
                for (i in 0 until arr.length()) drop.add(arr.optString(i))
            }

            val kept = ArrayList<String>()
            for (kv in (parsed.query ?: "").split("&")) {
                if (kv.isNotEmpty() && !drop.contains(kv.substringBefore("="))) kept.add(kv)
            }
            val extra = sign.optString("extra", "")
            if (extra.isNotEmpty()) kept.add(extra)
            kept.add(sign.optString("param", "wsSecret") + "=" + secret)
            kept.add(sign.optString("tsParam", "wsTime") + "=" + tsHex)

            val authority = if (parsed.port == -1) parsed.host else parsed.host + ":" + parsed.port
            parsed.protocol + "://" + authority + path + "?" + kept.joinToString("&")
        } catch (_: Exception) {
            raw
        }
    }

    private fun md5Hex(input: String): String {
        val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val value = byte.toInt() and 0xFF
            out.append(HEX_DIGITS[value shr 4]).append(HEX_DIGITS[value and 0x0F])
        }
        return out.toString()
    }

    // ---------------- HTTP 写出 ----------------

    private fun writeHead(
        out: BufferedOutputStream,
        status: Int,
        reason: String,
        contentType: String,
        contentLength: Long?,
        contentRange: String?,
    ) {
        val head = StringBuilder()
        head.append("HTTP/1.1 ").append(status)
        if (reason.isNotEmpty()) head.append(' ').append(reason)
        head.append("\r\n")
        head.append("Content-Type: ").append(contentType).append("\r\n")
        head.append("Accept-Ranges: bytes\r\n")
        head.append("Cache-Control: no-store\r\n")
        if (contentRange != null) head.append("Content-Range: ").append(contentRange).append("\r\n")
        if (contentLength != null && contentLength >= 0) {
            head.append("Content-Length: ").append(contentLength).append("\r\n")
        }
        // 每个请求一条连接，简单可靠；播放器会自己重用连接池
        head.append("Connection: close\r\n\r\n")
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun writeSimple(out: BufferedOutputStream, status: Int, reason: String) {
        writeHead(out, status, reason, "text/plain; charset=utf-8", 0L, null)
        out.flush()
    }

    private fun decodeBase64Url(text: String): String? = try {
        val padded = text + "=".repeat((4 - text.length % 4) % 4)
        String(Base64.decode(padded, Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }

    companion object {
        const val NAME = "MediaServer"
        private const val PLAYLIST_EVENT = "MediaServerPlaylist"
        private const val ROUTE_PREFIX = "m"
        private const val LOOPBACK = "127.0.0.1"
        private const val BACKLOG = 64
        private const val MAX_WORKERS = 8
        private const val MAX_HEAD_BYTES = 8192

        /** 转封装探测只要前 64KB —— PAT/PMT 就在 TS 最前面 */
        private const val PROBE_BYTES = 64 * 1024

        /** `#EXT-X-MAP` 指向的初始化段名。与 JS 侧 `MediaSession.initUrl()` 必须一致 */
        private const val INIT_SEGMENT_NAME = "init.mp4"
        private const val COPY_BUFFER = 64 * 1024
        private const val CONNECT_TIMEOUT_MS = 15000
        private const val READ_TIMEOUT_MS = 30000
        private const val REWRITE_TIMEOUT_MS = 5000L
        private const val CR = 13
        private const val LF = 10
        private val HEX_DIGITS = "0123456789abcdef".toCharArray()
    }
}
