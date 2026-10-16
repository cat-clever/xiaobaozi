package com.baozivideo.media

import java.io.ByteArrayOutputStream

/**
 * MPEG-TS（HEVC + AAC）-> fMP4 转封装（Android 侧）。
 *
 * ★★ 这是 `ios/BaoziVideo/Media/TsFmp4Remuxer.swift` 的**逐块对照移植**，
 *    逻辑一字不改 —— 那份是跟 ffmpeg 逐字节对拍验证过的
 *    （改动记录第三十轮：72543 / 86951 字节零差异），任何"顺手优化"都是在
 *    拿已经验证过的正确性冒险。要改先改 iOS 那边、重新对拍，再同步过来。
 *
 * ★ 为什么 Android 也需要它（iOS 那份的动机不适用于这里，但投屏场景适用）：
 *   接收端（ADisplay）在播放列表里**只看第一个分片行的后缀**判断要不要接手
 *   换封装 —— `.ts` 就判成 HEVC-in-TS，走它自己那条"全量下载 + FFmpeg 重封装"
 *   的路。而那条路**只为 Apple 的 AVPlayer 写的**，在 Android 电视上跑会崩
 *    （2026-10-16 真机踩到：281 份分片下去，接收端直接退出）。
 *
 *   所以投屏时我们自己先转好：投过去就是**真 fMP4**，接收端判成
 *   FragmentedMp4 -> 整条换封装路径不进入，Android 不崩、Apple 也能播。
 *
 * ★ 支持的输入（别的宁可抛错回退 —— 回退后仍是原来的表现，但绝不会给出
 *   半成品让播放器卡住）：
 *   - 视频：**HEVC（stream_type 0x24）或 H.264（0x1B）**
 *   - 音频：AAC ADTS（stream_type 0x0F；LATM 不支持）
 *   - 无加密、无 EXT-X-BYTERANGE、无 EXT-X-DISCONTINUITY
 *
 * ★★ 为什么后来要加 H.264（2026-10-16）：投屏到 ADisplay 时，它按分片后缀判
 *   封装格式 —— `.ts` 就走它自己的换封装，而它那份只认 HEVC，遇到 H.264 抛异常。
 *   而我们的源1 主线路正是 **H.264-TS**。既然投过去的东西我们说了算，干脆自己
 *   转成 fMP4：接收端判 FragmentedMp4，两条换封装路都不走，直接交给播放器。
 *
 * 用法（媒体服务里，一个流一个实例，跨分片保留时间轴原点）：
 *   val r = TsFmp4Remuxer()
 *   val frag = r.remux(firstSegment)    // 参数集 / ASC 都从它来
 *   val init = r.initSegment()          // 给播放器的 #EXT-X-MAP
 *   val frag2 = r.remux(secondSegment)  // 其余分片，逐片转
 */
class TsFmp4Remuxer {

    /** 转不了就抛它，调用方据此回退到原 TS 直通 */
    class RemuxException(message: String) : Exception(message)

    // ---------------------------------------------------------------- 内部模型

    /** 一个待写入的样本（时间戳单位是该轨的时基；dts 已减去 tfdt 原点） */
    private class Sample(
        var data: ByteArray,
        var dts: Long,
        var duration: Long,
        /** PTS - DTS（有 B 帧才非 0） */
        var cts: Long,
        var isSync: Boolean,
    )

    /** 一条轨道跨分片保留的信息 */
    private class Track(val id: Long, val timescale: Long)

    /**
     * 视频编码。两条路在**每一处**都要分开处理：
     *   NAL 头长度（HEVC 2 字节 / H.264 1 字节）、关键帧判定、参数集编号、
     *   SPS 语法、初始化段的 `hvcC` vs `avcC`。
     */
    private enum class Codec { Hevc, Avc }

    /** 由 `demux` 从 PMT 定下来（整条流一致） */
    private var codec: Codec = Codec.Hevc

    private class VideoParams(
        val chromaFormat: Int,
        val bitDepthLuma: Int,
        val bitDepthChroma: Int,
        /** hvcC 的头 12 字节（general_profile_space … general_level_idc） */
        val ptl: ByteArray,
        /** sps_max_sub_layers_minus1 + 1 */
        val temporalLayers: Int,
        val temporalIdNested: Boolean,
    )

    private var videoTrack: Track? = null
    private var audioTrack: Track? = null

    /**
     * 全流时间轴原点（90kHz）：视频首 DTS 与音频首 PTS 取小。
     *
     * ★ 两轨必须共用同一个原点，否则会丢掉**音视频彼此的初始偏移**。
     *   实测这条流第一帧的 cts = 14400（0.16s），音频首帧 PTS 正好落在那儿；
     *   各归一化各的就会让声音提前 0.16 秒。
     */
    private var origin90k: Long? = null

    /** 视频参数集（造 hvcC 用）。都是**列表** —— 这条流带了 4 个 PPS，只留第一个的话解码器可能找不到被引用的那个 */
    private val vpsNals = mutableListOf<ByteArray>()
    private val spsNals = mutableListOf<ByteArray>()
    private val ppsNals = mutableListOf<ByteArray>()
    private var videoWidth = 0
    private var videoHeight = 0
    private var hasVideoSize = false
    private var videoParams: VideoParams? = null

    /** AAC 的 AudioSpecificConfig（从 ADTS 头解析） */
    private var audioAsc: ByteArray? = null
    private var audioSampleRate = 44100
    private var audioChannels = 2

    private var sequence = 0L
    private var cachedInit: ByteArray? = null

    /** 转封装过至少一个分片没有（init 要等第一个分片才知道参数集） */
    val hasInit: Boolean get() = cachedInit != null

    // ---------------------------------------------------------------- 对外

    /**
     * 把一片 TS 转成一片 fMP4（moof + mdat）。第一次调用时顺便把 init 备好。
     */
    fun remux(segment: ByteArray): ByteArray {
        val demuxed = demux(segment)
        val videoSamples = buildVideoSamples(demuxed.videoPes)

        // 全流原点第一片时定下来：视频首 DTS 与音频首 PTS 取小（见 origin90k 的注释）
        if (origin90k == null) {
            val videoFirst = if (videoSamples.isEmpty()) 0L else videoSamples[0].dts
            var audioFirst: Long? = null
            for (pes in demuxed.audioPes) {
                if (pes.pts != null) {
                    audioFirst = pes.pts
                    break
                }
            }
            origin90k = minOf(videoFirst, audioFirst ?: videoFirst)
        }
        val origin = origin90k ?: 0L

        val audioSamples = buildAudioSamples(demuxed.audioPes, origin)
        if (videoSamples.isEmpty()) throw RemuxException("TS 结构异常：这片里没有视频样本")

        if (videoTrack == null) {
            videoTrack = Track(1, 90000)
            audioTrack = Track(2, audioSampleRate.toLong())
        }
        if (cachedInit == null) cachedInit = buildInitSegment()

        sequence += 1
        return buildFragment(videoSamples, audioSamples, origin)
    }

    /** `#EXT-X-MAP` 指向的初始化段（要在 `remux` 之后调） */
    fun initSegment(): ByteArray =
        cachedInit ?: throw RemuxException("TS 结构异常：还没有喂过任何分片")

    // ---------------------------------------------------------------- TS 解复用

    private class Pes(val pts: Long?, val dts: Long?, val payload: ByteArray)

    private class Demuxed(val videoPes: List<Pes>, val audioPes: List<Pes>)

    /** 扫一遍 TS，把视频/音频的 PES 收齐（184 字节净荷跨包重组，按 PES 长度裁掉填充） */
    private fun demux(data: ByteArray): Demuxed {
        val packetCount = data.size / 188
        if (packetCount <= 0 || data[0] != 0x47.toByte()) throw RemuxException("不是 MPEG-TS")

        var pmtPid = -1
        var videoPid = -1
        var audioPid = -1
        var videoType = 0
        var audioType = 0

        val videoPes = mutableListOf<Pes>()
        val audioPes = mutableListOf<Pes>()

        // 每个 PID 正在拼的 PES
        val partial = HashMap<Int, ByteArrayOutputStream>()
        val partialRemaining = HashMap<Int, Int>() // -1 = PES 长度未知
        val partialPts = HashMap<Int, Long?>()
        val partialDts = HashMap<Int, Long?>()

        fun flush(pid: Int) {
            val body = partial[pid]
            if (body == null || body.size() == 0) {
                partial.remove(pid)
                partialRemaining.remove(pid)
                return
            }
            val pes = Pes(partialPts[pid], partialDts[pid], body.toByteArray())
            if (pid == videoPid) videoPes.add(pes) else if (pid == audioPid) audioPes.add(pes)
            partial.remove(pid)
            partialRemaining.remove(pid)
        }

        for (index in 0 until packetCount) {
            val base = index * 188
            // 对齐就整条对齐；中途错位就放弃这片（宁可回退到原 TS）
            if (data[base] != 0x47.toByte()) throw RemuxException("TS 结构异常：第 $index 包没有同步字节")

            val pid = ((data[base + 1].toInt() and 0x1F) shl 8) or (data[base + 2].toInt() and 0xFF)
            val payloadStart = (data[base + 1].toInt() and 0x40) != 0
            val adaptationControl = (data[base + 3].toInt() shr 4) and 0x03

            var offset = base + 4
            if (adaptationControl == 2 || adaptationControl == 3) {
                val length = data[offset].toInt() and 0xFF
                offset += 1 + length
                if (adaptationControl == 2) continue // 只有适配域，没有净荷
            }
            if (offset >= base + 188) continue

            // PAT / PMT：净荷第一个字节是 pointer_field，之后才是 section
            if (pid == 0) {
                if (payloadStart) {
                    val pointer = data[offset].toInt() and 0xFF
                    val sectionStart = offset + 1 + pointer
                    if (sectionStart < base + 188) {
                        val mapPid = parsePat(data, sectionStart, base + 188)
                        if (mapPid != null) pmtPid = mapPid
                    }
                }
                continue
            }

            if (pmtPid >= 0 && pid == pmtPid) {
                if (payloadStart) {
                    val pointer = data[offset].toInt() and 0xFF
                    val sectionStart = offset + 1 + pointer
                    if (sectionStart < base + 188) {
                        for (stream in parsePmt(data, sectionStart, base + 188)) {
                            val type = stream.type
                            if (type == 0x0F || type == 0x11) {
                                audioPid = stream.pid
                                audioType = type
                            } else if (isVideoStreamType(type) && videoPid < 0) {
                                // 视频流一律记下来（**含不支持的编码**）—— 后面才能如实报
                                // "不支持 HEVC 以外的编码"，而不是误报"没有视频轨"
                                videoPid = stream.pid
                                videoType = type
                            }
                        }
                    }
                }
                continue
            }

            if (pid != videoPid && pid != audioPid) continue

            if (payloadStart) {
                flush(pid)
                // PES 头：00 00 01 <stream_id>
                if (base + 188 - offset < 9) continue
                if (data[offset] != 0.toByte() || data[offset + 1] != 0.toByte() ||
                    data[offset + 2] != 1.toByte()
                ) {
                    continue
                }
                val pesLength = ((data[offset + 4].toInt() and 0xFF) shl 8) or (data[offset + 5].toInt() and 0xFF)
                val flags = data[offset + 7].toInt() and 0xFF
                val headerDataLength = data[offset + 8].toInt() and 0xFF
                var pts: Long? = null
                var dts: Long? = null
                if ((flags and 0x80) != 0) {
                    pts = readTimestamp(data, offset + 9)
                    if ((flags and 0x40) != 0) dts = readTimestamp(data, offset + 14)
                }
                val bodyStart = offset + 9 + headerDataLength
                if (bodyStart > base + 188) continue
                var bodyEnd = base + 188
                var remaining = -1
                if (pesLength != 0) {
                    // PES 总长 = 6 + pesLength；净荷 = 总长 - 6 - 3 - headerDataLength
                    remaining = maxOf(0, pesLength - 3 - headerDataLength)
                    bodyEnd = minOf(bodyEnd, bodyStart + remaining)
                }
                val out = ByteArrayOutputStream()
                out.write(data, bodyStart, bodyEnd - bodyStart)
                partial[pid] = out
                partialRemaining[pid] = if (remaining >= 0) remaining - out.size() else -1
                partialPts[pid] = pts
                partialDts[pid] = dts
            } else {
                val existing = partial[pid] ?: continue
                val remaining = partialRemaining[pid] ?: -1
                if (remaining == 0) continue // 这段全是填充
                var end = base + 188
                if (remaining > 0) end = minOf(end, offset + remaining)
                existing.write(data, offset, end - offset)
                if (remaining > 0) partialRemaining[pid] = remaining - (end - offset)
            }
        }

        if (videoPid < 0) throw RemuxException("这条流里没有视频轨")
        when (videoType) {
            0x24 -> codec = Codec.Hevc
            0x1B -> codec = Codec.Avc
            else -> throw RemuxException(
                "视频编码不支持转封装：stream_type=0x%02X（只支持 HEVC 0x24 / H.264 0x1B）"
                    .format(videoType),
            )
        }
        if (audioPid < 0) throw RemuxException("这条流里没有音频轨")
        if (audioType != 0x0F) {
            throw RemuxException(
                "音频编码不支持转封装：stream_type=0x%02X（只支持 AAC ADTS 0x0F）".format(audioType),
            )
        }
        flush(videoPid)
        flush(audioPid)

        return Demuxed(videoPes, audioPes)
    }

    /** PES 头里的 5 字节时间戳（33 位 @90kHz） */
    private fun readTimestamp(data: ByteArray, at: Int): Long {
        if (at + 4 >= data.size) return 0
        val a = (data[at].toLong() and 0x0E) shl 29
        val b = data[at + 1].toLong() shl 22
        val c = (data[at + 2].toLong() and 0xFE) shl 14
        val d = data[at + 3].toLong() shl 7
        val e = data[at + 4].toLong() shr 1
        return a or b or c or d or e
    }

    /** PAT -> PMT 的 PID（`start` 是 section 起点，已跳过 pointer_field） */
    private fun parsePat(bytes: ByteArray, start: Int, limit: Int): Int? {
        if (start + 8 >= limit) return null
        if (bytes[start] != 0.toByte()) return null
        val sectionLength = ((bytes[start + 1].toInt() and 0x0F) shl 8) or (bytes[start + 2].toInt() and 0xFF)
        val end = minOf(limit, start + 3 + sectionLength - 4)
        var i = start + 8
        while (i + 3 < end) {
            val program = ((bytes[i].toInt() and 0xFF) shl 8) or (bytes[i + 1].toInt() and 0xFF)
            val pid = ((bytes[i + 2].toInt() and 0x1F) shl 8) or (bytes[i + 3].toInt() and 0xFF)
            if (program != 0) return pid
            i += 4
        }
        return null
    }

    private class PmtEntry(val type: Int, val pid: Int)

    /** PMT -> (stream_type, elementary_PID) 列表 */
    private fun parsePmt(bytes: ByteArray, start: Int, limit: Int): List<PmtEntry> {
        if (start + 12 >= limit) return emptyList()
        if (bytes[start] != 0x02.toByte()) return emptyList()
        val sectionLength = ((bytes[start + 1].toInt() and 0x0F) shl 8) or (bytes[start + 2].toInt() and 0xFF)
        val programInfoLength = ((bytes[start + 10].toInt() and 0x0F) shl 8) or (bytes[start + 11].toInt() and 0xFF)
        val end = minOf(limit, start + 3 + sectionLength - 4)
        var i = start + 12 + programInfoLength
        val out = mutableListOf<PmtEntry>()
        while (i + 4 < end) {
            val type = bytes[i].toInt() and 0xFF
            val pid = ((bytes[i + 1].toInt() and 0x1F) shl 8) or (bytes[i + 2].toInt() and 0xFF)
            val esInfoLength = ((bytes[i + 3].toInt() and 0x0F) shl 8) or (bytes[i + 4].toInt() and 0xFF)
            out.add(PmtEntry(type, pid))
            i += 5 + esInfoLength
        }
        return out
    }

    // ---------------------------------------------------------------- Annex-B / NAL

    /**
     * 按起始码切 NAL。**只返回已被下一个起始码终结的 NAL**；
     * 从最后一个起始码起的那段（可能还没收完）原样返回，留给下一次或片尾。
     *
     * ★ 第一版把"最后一段"既当成完整 NAL 又在 carry 里留着，于是跨 PES 的 NAL
     *   会被截断、尾巴丢掉（转出来的样本就散了）。
     *
     * HEVC 的 NAL 头是两字节：type = (b0 >> 1) & 0x3F
     */
    private class SplitResult(val nals: List<ByteArray>, val rest: ByteArray)

    private fun splitAnnexB(buffer: ByteArray): SplitResult {
        val starts = mutableListOf<Int>()
        var i = 0
        while (i + 2 < buffer.size) {
            if (buffer[i] == 0.toByte() && buffer[i + 1] == 0.toByte() && buffer[i + 2] == 1.toByte()) {
                starts.add(i)
                i += 3
            } else {
                i += 1
            }
        }
        if (starts.size < 2) return SplitResult(emptyList(), buffer)

        val nals = mutableListOf<ByteArray>()
        for (n in 0 until starts.size - 1) {
            val from = starts[n] + 3
            val to = starts[n + 1]
            if (to <= from) continue
            var end = to
            // 4 字节起始码会在上一段末尾留一个 0x00；Annex-B 的尾部补零也不属于 NAL
            while (end > from && buffer[end - 1] == 0.toByte()) end -= 1
            if (end > from) nals.add(buffer.copyOfRange(from, end))
        }
        // 最后一个起始码之后的部分（含起始码本身）留到下一次
        val rest = buffer.copyOfRange(starts[starts.size - 1], buffer.size)
        return SplitResult(nals, rest)
    }

    /** 片尾用：carry 里那个"没被下一个起始码终结"的 NAL 其实已经完整了，取出来 */
    private fun trailingNal(carry: ByteArray): ByteArray? {
        if (carry.size <= 3) return null
        if (carry[0] != 0.toByte() || carry[1] != 0.toByte() || carry[2] != 1.toByte()) return null
        var end = carry.size
        while (end > 3 && carry[end - 1] == 0.toByte()) end -= 1
        return if (end <= 3) null else carry.copyOfRange(3, end)
    }

    /**
     * NAL 类型。
     *
     * ★ 两种编码的**头长度不一样**，这是最容易搞错的一处：
     *   - HEVC：2 字节头，`type = (b0 >> 1) & 0x3F`
     *   - H.264：1 字节头，`type = b0 & 0x1F`
     */
    private fun nalType(nal: ByteArray): Int {
        if (codec == Codec.Avc) {
            if (nal.isEmpty()) return -1
            return nal[0].toInt() and 0x1F
        }
        if (nal.size < 2) return -1
        return (nal[0].toInt() shr 1) and 0x3F
    }

    /** NAL 头占几个字节（决定 BitReader 跳过多少） */
    private fun nalHeaderBytes(): Int = if (codec == Codec.Avc) 1 else 2

    /**
     * 是不是 AUD（接入单元分隔符）—— 一个 AU 的明确边界。
     *
     * ★ 编号两套：HEVC 是 35，**H.264 是 9**。认错的话 AU 切分就乱了。
     */
    private fun isAud(type: Int): Boolean = if (codec == Codec.Avc) type == 9 else type == 35

    /**
     * 这个 NAL 是不是"压缩切片"（VCL）。
     *
     * ★ 两种编码的编号区间完全不同，不能共用一套判断：
     *   - HEVC：0..31
     *   - H.264：1..5（1 非 IDR 片、2-4 分区、5 IDR 片）
     */
    private fun isVcl(type: Int): Boolean =
        if (codec == Codec.Avc) type in 1..5 else type in 0..31

    /**
     * 这个切片是不是**关键帧**（IRAP / IDR）。
     *
     *   - HEVC：16..23（BLA/IDR/CRA）
     *   - H.264：**只有 5 是 IDR** —— 1-4 都是非关键帧
     */
    private fun isIrap(type: Int): Boolean =
        if (codec == Codec.Avc) type == 5 else type in 16..23

    /**
     * 这个切片是不是**新图像的起点**。
     *
     *   - HEVC：`first_slice_segment_in_pic_flag`（1 bit）
     *   - H.264：`first_mb_in_slice`（ue）—— **等于 0 才是新图像**
     */
    private fun startsNewPicture(nal: ByteArray): Boolean {
        if (nal.size < 3) return false
        val reader = BitReader(nal, nalHeaderBytes())
        return try {
            if (codec == Codec.Avc) reader.readUE() == 0L else reader.readFlag()
        } catch (_: RemuxException) {
            false
        }
    }

    /**
     * 记下参数集。
     *
     * ★ NAL 编号两套：
     *   - HEVC：32 VPS / 33 SPS / 34 PPS
     *   - H.264：**7 SPS / 8 PPS**（没有 VPS）
     */
    private fun noteParameterSets(nal: ByteArray, type: Int) {
        if (codec == Codec.Avc) {
            when (type) {
                7 -> {
                    if (!containsBytes(spsNals, nal)) spsNals.add(nal)
                    if (!hasVideoSize && spsNals.isNotEmpty()) parseSps(spsNals[0])
                }
                8 -> if (!containsBytes(ppsNals, nal)) ppsNals.add(nal)
            }
            return
        }
        when (type) {
            32 -> if (!containsBytes(vpsNals, nal)) vpsNals.add(nal)
            33 -> {
                if (!containsBytes(spsNals, nal)) spsNals.add(nal)
                if (!hasVideoSize && spsNals.isNotEmpty()) parseSps(spsNals[0])
            }
            34 -> if (!containsBytes(ppsNals, nal)) ppsNals.add(nal)
        }
    }

    private fun containsBytes(list: List<ByteArray>, item: ByteArray): Boolean {
        for (existing in list) if (existing.contentEquals(item)) return true
        return false
    }

    // ---------------------------------------------------------------- 视频样本（按 AU 组装）

    private fun buildVideoSamples(pesList: List<Pes>): List<Sample> {
        val samples = mutableListOf<Sample>()
        var auNals = mutableListOf<ByteArray>()
        var auPts: Long? = null
        var auDts: Long? = null
        var auType = -1
        var carry = ByteArray(0)

        fun flushAu() {
            if (auNals.isEmpty()) return
            val pts = auPts ?: auDts ?: 0L
            val dts = auDts ?: pts
            val payload = ByteArrayOutputStream()
            for (nal in auNals) {
                val length = nal.size
                payload.write((length ushr 24) and 0xFF)
                payload.write((length ushr 16) and 0xFF)
                payload.write((length ushr 8) and 0xFF)
                payload.write(length and 0xFF)
                payload.write(nal, 0, nal.size)
            }
            samples.add(Sample(payload.toByteArray(), dts, 0, pts - dts, isIrap(auType)))
            auNals = mutableListOf()
            auType = -1
            auPts = null
            auDts = null
        }

        fun hasVcl(): Boolean {
            for (nal in auNals) if (isVcl(nalType(nal))) return true
            return false
        }

        fun handle(nal: ByteArray, pesPts: Long?, pesDts: Long?) {
            val type = nalType(nal)
            if (auPts == null) {
                auPts = pesPts ?: pesDts
                auDts = pesDts ?: pesPts
            }

            if (isAud(type)) { // AUD：一个 AU 的明确分界
                if (hasVcl()) {
                    flushAu()
                    auPts = pesPts ?: pesDts
                    auDts = pesDts ?: pesPts
                }
                auNals.add(nal) // ★ 留在样本里（参考实现也留）
                return
            }
            if (isVcl(type)) {
                if (startsNewPicture(nal) && hasVcl()) {
                    flushAu()
                    auPts = pesPts ?: pesDts
                    auDts = pesDts ?: pesPts
                }
                if (auType < 0) auType = type // 第一个 VCL 的类型决定这一 AU 是不是关键帧
            } else {
                noteParameterSets(nal, type)
            }
            auNals.add(nal)
        }

        var lastPesPts: Long? = null
        var lastPesDts: Long? = null
        for (pes in pesList) {
            // 带 PTS 的新 PES 就是新 AU（ffmpeg 多路复用下 1 个 PES = 1 个 AU；
            // 超大 AU 会被拆成多个 PES，只有第一个带 PTS）
            if (pes.pts != null && hasVcl()) flushAu()

            val buffer = carry + pes.payload
            val split = splitAnnexB(buffer)
            carry = split.rest
            if (pes.pts != null) lastPesPts = pes.pts
            if (pes.dts != null) lastPesDts = pes.dts

            for (nal in split.nals) handle(nal, pes.pts, pes.dts)
        }

        // 片尾：carry 里是最后一个 NAL（已完整，只是没有下一个起始码来终结它）
        val last = trailingNal(carry)
        if (last != null) handle(last, lastPesPts, lastPesDts)
        flushAu()
        return samples
    }

    // ---------------------------------------------------------------- 音频样本（ADTS）

    private fun buildAudioSamples(pesList: List<Pes>, origin90k: Long): List<Sample> {
        val buffer = ByteArrayOutputStream()
        for (pes in pesList) buffer.write(pes.payload, 0, pes.payload.size)
        val bytes = buffer.toByteArray()
        if (bytes.isEmpty()) return emptyList()

        // 第一帧的时间戳取第一个带 PTS 的 PES，再换算到音频时基（相对全流原点）；
        // 之后按 1024 采样累加。
        // ★ 这条流是 HE-AAC（ADTS 头写 24000 + 带内 SBR，解码后 48000）。
        //   我按 ADTS 头的时基如实声明 24000，每帧 1024 采样 —— 换算成真实时长
        //   42.67ms 与 SBR 的 2048@48000 完全一致，所以音画对得上；
        //   解码器认不认 SBR 只影响高频，不影响速度。
        var firstPts: Long? = null
        for (pes in pesList) {
            if (pes.pts != null) {
                firstPts = pes.pts
                break
            }
        }

        val samples = mutableListOf<Sample>()
        var i = 0
        while (i + 7 <= bytes.size) {
            if (bytes[i] != 0xFF.toByte() || (bytes[i + 1].toInt() and 0xF0) != 0xF0 ||
                (bytes[i + 1].toInt() and 0x06) != 0
            ) {
                i += 1
                continue
            }
            val protectionAbsent = (bytes[i + 1].toInt() and 0x01) == 1
            val headerLength = if (protectionAbsent) 7 else 9
            val profile = (bytes[i + 2].toInt() shr 6) and 0x03
            val sampleRateIndex = (bytes[i + 2].toInt() shr 2) and 0x0F
            val channelConfig = ((bytes[i + 2].toInt() and 0x01) shl 2) or ((bytes[i + 3].toInt() shr 6) and 0x03)
            val frameLength = ((bytes[i + 3].toInt() and 0x03) shl 11) or
                ((bytes[i + 4].toInt() and 0xFF) shl 3) or
                ((bytes[i + 5].toInt() shr 5) and 0x07)
            if (frameLength <= headerLength || i + frameLength > bytes.size) break
            if (sampleRateIndex >= SAMPLE_RATES.size) {
                throw RemuxException("音频编码不支持转封装：采样率索引 $sampleRateIndex")
            }

            if (audioAsc == null) {
                audioSampleRate = SAMPLE_RATES[sampleRateIndex]
                audioChannels = if (channelConfig == 0) 2 else channelConfig
                val asc = ((profile + 1) and 0x1F) shl 11 or
                    ((sampleRateIndex and 0x0F) shl 7) or
                    ((channelConfig and 0x0F) shl 3)
                audioAsc = byteArrayOf(((asc shr 8) and 0xFF).toByte(), (asc and 0xFF).toByte())
            }

            val dts: Long
            if (samples.isNotEmpty()) {
                val lastSample = samples[samples.size - 1]
                dts = lastSample.dts + lastSample.duration
            } else {
                dts = maxOf(0, rescale((firstPts ?: origin90k) - origin90k, 90000, audioSampleRate.toLong()))
            }

            samples.add(
                Sample(
                    bytes.copyOfRange(i + headerLength, i + frameLength),
                    dts,
                    1024,
                    0,
                    true,
                ),
            )
            i += frameLength
        }

        if (samples.isEmpty()) throw RemuxException("音频编码不支持转封装：没解出 ADTS 帧")
        return samples
    }

    private fun rescale(value: Long, from: Long, to: Long): Long {
        if (from <= 0) return value
        return Math.round(value.toDouble() * to.toDouble() / from.toDouble())
    }

    // ---------------------------------------------------------------- SPS 解析（宽高 / 色度 / 位深 / PTL）

    private fun parseSps(nal: ByteArray) {
        if (codec == Codec.Avc) {
            parseSpsAvc(nal)
            return
        }
        val reader = BitReader(nal, 2)
        try {
            reader.readBits(4) // video_parameter_set_id
            val maxSubLayersMinus1 = reader.readBits(3).toInt()
            val temporalIdNested = reader.readFlag()

            // profile_tier_level(1, maxSubLayersMinus1) —— 前 12 字节正好是 hvcC 要的那段
            val ptl = ByteArrayOutputStream()
            for (n in 0 until 12) ptl.write(reader.readBits(8).toInt())
            val ptlBytes = ptl.toByteArray()

            // 跳过子层的 profile/level 标志位，才能继续读 SPS 正文
            if (maxSubLayersMinus1 > 0) {
                val subLayerProfile = BooleanArray(maxSubLayersMinus1)
                val subLayerLevel = BooleanArray(maxSubLayersMinus1)
                for (n in 0 until maxSubLayersMinus1) {
                    subLayerProfile[n] = reader.readFlag()
                    subLayerLevel[n] = reader.readFlag()
                }
                reader.skipBits((8 - maxSubLayersMinus1) * 2)
                for (n in 0 until maxSubLayersMinus1) {
                    if (subLayerProfile[n]) reader.skipBits(88)
                    if (subLayerLevel[n]) reader.skipBits(8)
                }
            }

            // ★ sps_seq_parameter_set_id 必须先读 —— 少读一个 ue 后面全部错位
            //   （第一版漏了它，结果 chromaFormat 读成 0[单色]、位深读成 15bit）
            reader.readUE() // sps_seq_parameter_set_id
            val chromaFormat = reader.readUE().toInt()
            if (chromaFormat == 3) reader.readFlag()
            val width = reader.readUE().toInt()
            val height = reader.readUE().toInt()

            var cropLeft = 0
            var cropRight = 0
            var cropTop = 0
            var cropBottom = 0
            if (reader.readFlag()) {
                cropLeft = reader.readUE().toInt()
                cropRight = reader.readUE().toInt()
                cropTop = reader.readUE().toInt()
                cropBottom = reader.readUE().toInt()
            }
            val bitDepthLuma = reader.readUE().toInt() + 8
            val bitDepthChroma = reader.readUE().toInt() + 8

            // 裁剪窗口换算成显示尺寸（SubWidthC / SubHeightC 由色度格式决定）
            val subWidthC = if (chromaFormat == 1 || chromaFormat == 2) 2 else 1
            val subHeightC = if (chromaFormat == 1) 2 else 1
            val displayWidth = width - (cropLeft + cropRight) * subWidthC
            val displayHeight = height - (cropTop + cropBottom) * subHeightC

            videoWidth = maxOf(1, displayWidth)
            videoHeight = maxOf(1, displayHeight)
            hasVideoSize = true
            videoParams = VideoParams(
                chromaFormat,
                bitDepthLuma,
                bitDepthChroma,
                ptlBytes,
                maxOf(1, maxSubLayersMinus1 + 1),
                temporalIdNested,
            )
        } catch (_: RemuxException) {
            // 参数读不全就当没读到 —— 上层会因为没有参数集而回退（见 buildInitSegment）
        }
    }

    /**
     * H.264 的 SPS 解析（只取宽高与裁剪，够造 `avc1` 用）。
     *
     * ★ 语法跟 HEVC 完全是两套，别想着复用：HEVC 那边开头是
     *   `sps_video_parameter_set_id` + profile_tier_level，这边是
     *   `profile_idc` / constraint flags / `level_idc` 三个字节起头。
     *
     * ★ 高 profile（100/110/122/…）多出一整段色度/位深/缩放矩阵字段，
     *   漏读一个 ue 后面全部错位 —— 所以必须先按 `profile_idc` 分流。
     */
    private fun parseSpsAvc(nal: ByteArray) {
        // H.264 的 NAL 头是 1 字节
        val reader = BitReader(nal, 1)
        try {
            val profileIdc = reader.readBits(8).toInt()
            reader.readBits(8) // constraint_set0..5 + reserved
            reader.readBits(8) // level_idc
            reader.readUE() // seq_parameter_set_id

            var chromaFormatIdc = 1
            if (profileIdc in HIGH_PROFILES) {
                chromaFormatIdc = reader.readUE().toInt()
                if (chromaFormatIdc == 3) reader.readFlag() // separate_colour_plane_flag
                reader.readUE() // bit_depth_luma_minus8
                reader.readUE() // bit_depth_chroma_minus8
                reader.readFlag() // qpprime_y_zero_transform_bypass_flag
                if (reader.readFlag()) { // seq_scaling_matrix_present_flag
                    val count = if (chromaFormatIdc != 3) 8 else 12
                    for (n in 0 until count) {
                        if (reader.readFlag()) skipScalingList(reader, if (n < 6) 16 else 64)
                    }
                }
            }

            reader.readUE() // log2_max_frame_num_minus4
            when (reader.readUE().toInt()) { // pic_order_cnt_type
                0 -> reader.readUE() // log2_max_pic_order_cnt_lsb_minus4
                1 -> {
                    reader.readFlag() // delta_pic_order_always_zero_flag
                    reader.readSE() // offset_for_non_ref_pic
                    reader.readSE() // offset_for_top_to_bottom_field
                    val cycle = reader.readUE().toInt()
                    for (n in 0 until cycle) reader.readSE()
                }
            }
            reader.readUE() // max_num_ref_frames
            reader.readFlag() // gaps_in_frame_num_value_allowed_flag

            val widthMbs = reader.readUE().toInt() + 1
            val heightMapUnits = reader.readUE().toInt() + 1
            val frameMbsOnly = reader.readFlag()
            if (!frameMbsOnly) reader.readFlag() // mb_adaptive_frame_field_flag
            reader.readFlag() // direct_8x8_inference_flag

            var cropLeft = 0
            var cropRight = 0
            var cropTop = 0
            var cropBottom = 0
            if (reader.readFlag()) { // frame_cropping_flag
                cropLeft = reader.readUE().toInt()
                cropRight = reader.readUE().toInt()
                cropTop = reader.readUE().toInt()
                cropBottom = reader.readUE().toInt()
            }

            // 裁剪单位由色度格式与帧/场编码决定（H.264 8.3.2.2 那套）
            val subWidthC = if (chromaFormatIdc == 1 || chromaFormatIdc == 2) 2 else 1
            val subHeightC = if (chromaFormatIdc == 1) 2 else 1
            val frameHeightFactor = if (frameMbsOnly) 1 else 2
            val cropUnitX = if (chromaFormatIdc == 0) 1 else subWidthC
            val cropUnitY = if (chromaFormatIdc == 0) frameHeightFactor else subHeightC * frameHeightFactor

            val width = widthMbs * 16 - (cropLeft + cropRight) * cropUnitX
            val height = frameHeightFactor * heightMapUnits * 16 - (cropTop + cropBottom) * cropUnitY

            videoWidth = maxOf(1, width)
            videoHeight = maxOf(1, height)
            hasVideoSize = true
        } catch (_: RemuxException) {
            // 读不全就当没读到，上层会因为没有参数集而回退
        }
    }

    /** 跳过一段 scaling list（H.264 7.3.2.1.1.1）—— 只要位对齐，值本身用不上 */
    private fun skipScalingList(reader: BitReader, size: Int) {
        var lastScale = 8
        var nextScale = 8
        for (n in 0 until size) {
            if (nextScale != 0) {
                val delta = reader.readSE().toInt()
                nextScale = (lastScale + delta + 256) % 256
            }
            if (nextScale != 0) lastScale = nextScale
        }
    }

    // ---------------------------------------------------------------- init 段

    private fun buildInitSegment(): ByteArray {
        if (spsNals.isEmpty() || ppsNals.isEmpty() || !hasVideoSize) {
            throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")
        }
        val asc = audioAsc
            ?: throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")
        val vTrack = videoTrack
            ?: throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")
        val aTrack = audioTrack
            ?: throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")

        // ★ 两条路的 sample entry 不同：
        //   HEVC -> hvc1 + hvcC（还要 VPS，缺一不可）
        //   H.264 -> avc1 + avcC（**没有 VPS**）
        val videoBrand: String
        val sampleEntry: ByteArray
        if (codec == Codec.Avc) {
            videoBrand = "avc1"
            sampleEntry = avc1Entry(videoWidth, videoHeight, buildAvcC(spsNals, ppsNals))
        } else {
            if (vpsNals.isEmpty()) {
                throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")
            }
            val params = videoParams
                ?: throw RemuxException("TS 结构异常：参数集 / 音频配置不齐，造不出 init")
            videoBrand = "hvc1"
            sampleEntry = hvc1Entry(videoWidth, videoHeight, buildHvcC(vpsNals, spsNals, ppsNals, params))
        }

        val ftypPayload = ByteArrayOutputStream()
        ftypPayload.write("isom".toByteArray(Charsets.US_ASCII))
        ftypPayload.write(uint32(512))
        for (brand in listOf("isom", "iso5", "iso6", "mp41", videoBrand)) {
            ftypPayload.write(brand.toByteArray(Charsets.US_ASCII))
        }
        val ftyp = box("ftyp", ftypPayload.toByteArray())

        val moovBody = ByteArrayOutputStream()
        moovBody.write(mvhd(3))
        moovBody.write(videoTrak(sampleEntry, vTrack))
        moovBody.write(audioTrak(asc, aTrack))
        moovBody.write(mvex(listOf(vTrack, aTrack)))
        val moov = box("moov", moovBody.toByteArray())

        val out = ByteArrayOutputStream()
        out.write(ftyp)
        out.write(moov)
        return out.toByteArray()
    }

    /**
     * `avcC`（AVCDecoderConfigurationRecord，ISO/IEC 14496-15 5.3.3.1）。
     *
     * ★ 头三个字节**直接从 SPS 里抄**（SPS 的前 4 字节是 NAL 头 + profile +
     *   constraint flags + level）—— 不用自己解析 profile/level。
     */
    private fun buildAvcC(sps: List<ByteArray>, pps: List<ByteArray>): ByteArray {
        val first = sps[0]
        if (first.size < 4) throw RemuxException("TS 结构异常：SPS 太短，造不出 avcC")
        val payload = ByteArrayOutputStream()
        payload.write(1) // configurationVersion
        payload.write(first[1].toInt() and 0xFF) // AVCProfileIndication
        payload.write(first[2].toInt() and 0xFF) // profile_compatibility
        payload.write(first[3].toInt() and 0xFF) // AVCLevelIndication
        payload.write(0xFF or 0x03) // lengthSizeMinusOne = 3（4 字节长度前缀，与样本组装一致）
        payload.write(0xE0 or minOf(31, sps.size)) // numOfSequenceParameterSets
        for (item in sps) {
            payload.write(uint16(item.size))
            payload.write(item, 0, item.size)
        }
        payload.write(minOf(255, pps.size)) // numOfPictureParameterSets
        for (item in pps) {
            payload.write(uint16(item.size))
            payload.write(item, 0, item.size)
        }
        return box("avcC", payload.toByteArray())
    }

    private fun mvex(tracks: List<Track>): ByteArray {
        val payload = ByteArrayOutputStream()
        for (track in tracks) {
            val trex = ByteArrayOutputStream()
            trex.write(uint32(track.id))
            trex.write(uint32(1)) // default_sample_description_index
            trex.write(uint32(0)) // default_sample_duration
            trex.write(uint32(0)) // default_sample_size
            trex.write(uint32(0)) // default_sample_flags
            // ★ trex 是 FullBox（ISO/IEC 14496-12 8.8.3）—— 少写 4 字节 version/flags，
            //   解析方就会把 track_id 读成 version+flags，整条轨道全错。
            payload.write(fullBox("trex", 0, 0, trex.toByteArray()))
        }
        return box("mvex", payload.toByteArray())
    }

    private fun videoTrak(sampleEntry: ByteArray, track: Track): ByteArray {
        val tkhd = fullBox("tkhd", 0, 0x7, tkhdPayload(track.id, videoWidth, videoHeight))
        val mdhd = mdhdBox(track.timescale)
        val minfBody = ByteArrayOutputStream()
        minfBody.write(fullBox("vmhd", 0, 1, uint16(0) + uint16(0) + uint16(0) + uint16(0)))
        minfBody.write(dinfBox())
        minfBody.write(stblBox(sampleEntry))
        val minf = box("minf", minfBody.toByteArray())

        val mdiaBody = ByteArrayOutputStream()
        mdiaBody.write(mdhd)
        mdiaBody.write(handlerBox("vide", "VideoHandler"))
        mdiaBody.write(minf)
        val mdia = box("mdia", mdiaBody.toByteArray())

        val out = ByteArrayOutputStream()
        out.write(tkhd)
        out.write(mdia)
        return box("trak", out.toByteArray())
    }

    private fun audioTrak(asc: ByteArray, track: Track): ByteArray {
        val tkhd = fullBox("tkhd", 0, 0x7, tkhdPayload(track.id, 0, 0))
        val mdhd = mdhdBox(track.timescale)
        val minfBody = ByteArrayOutputStream()
        minfBody.write(fullBox("smhd", 0, 0, uint16(0) + uint16(0)))
        minfBody.write(dinfBox())
        minfBody.write(stblBox(mp4aEntry(audioSampleRate, audioChannels, asc)))
        val minf = box("minf", minfBody.toByteArray())

        val mdiaBody = ByteArrayOutputStream()
        mdiaBody.write(mdhd)
        mdiaBody.write(handlerBox("soun", "SoundHandler"))
        mdiaBody.write(minf)
        val mdia = box("mdia", mdiaBody.toByteArray())

        val out = ByteArrayOutputStream()
        out.write(tkhd)
        out.write(mdia)
        return box("trak", out.toByteArray())
    }

    // ---------------------------------------------------------------- 分片（moof + mdat）

    private fun buildFragment(video: List<Sample>, audio: List<Sample>, origin: Long): ByteArray {
        val vTrack = videoTrack ?: throw RemuxException("TS 结构异常：轨道没建起来")
        val aTrack = audioTrack ?: throw RemuxException("TS 结构异常：轨道没建起来")
        val videoSamples = finalizedVideo(video, origin)
        val audioSamples = finalizedAudio(audio)

        val videoData = concat(videoSamples.map { it.data })
        val audioData = concat(audioSamples.map { it.data })

        fun traf(track: Track, samples: List<Sample>, dataOffset: Int): ByteArray {
            val tfhd = ByteArrayOutputStream()
            tfhd.write(uint32(track.id))
            val tfhdBox = fullBox("tfhd", 0, 0x020000, tfhd.toByteArray()) // default-base-is-moof

            val firstDts = if (samples.isEmpty()) 0L else samples[0].dts
            val tfdtBox = fullBox("tfdt", 1, 0, uint64(maxOf(0L, firstDts)))

            val trun = ByteArrayOutputStream()
            trun.write(uint32(samples.size.toLong()))
            trun.write(int32(dataOffset))
            for (sample in samples) {
                trun.write(uint32(maxOf(1L, sample.duration)))
                trun.write(uint32(sample.data.size.toLong()))
                trun.write(uint32(if (sample.isSync) 0x02000000L else 0x01010000L))
                trun.write(int32(sample.cts.toInt()))
            }
            // flags: data-offset | sample-duration | sample-size | sample-flags | composition-offset
            val trunBox = fullBox("trun", 1, 0xF01, trun.toByteArray())

            val trafBody = ByteArrayOutputStream()
            trafBody.write(tfhdBox)
            trafBody.write(tfdtBox)
            trafBody.write(trunBox)
            return box("traf", trafBody.toByteArray())
        }

        // 先量一次算出 moof 大小（trun 里字段宽度不随值变化，量出来就是最终大小），
        // 再按真实偏移重造一遍 —— 比"写完回填"简单也不会漏
        val mfhdProbe = fullBox("mfhd", 0, 0, uint32(sequence))
        val probeBody = ByteArrayOutputStream()
        probeBody.write(mfhdProbe)
        probeBody.write(traf(vTrack, videoSamples, 0))
        if (audioSamples.isNotEmpty()) probeBody.write(traf(aTrack, audioSamples, 0))
        val moofSize = probeBody.size() + 8

        val body = ByteArrayOutputStream()
        body.write(mfhdProbe)
        body.write(traf(vTrack, videoSamples, moofSize + 8))
        if (audioSamples.isNotEmpty()) {
            body.write(traf(aTrack, audioSamples, moofSize + 8 + videoData.size))
        }
        if (body.size() + 8 != moofSize) throw RemuxException("TS 结构异常：moof 长度不稳定")

        val mdat = ByteArrayOutputStream()
        mdat.write(videoData)
        mdat.write(audioData)

        // 分片开头给个 styp（"media segment type"，Apple 的 fMP4 分片惯例）
        val stypPayload = ByteArrayOutputStream()
        stypPayload.write("msdh".toByteArray(Charsets.US_ASCII))
        stypPayload.write(uint32(0))
        for (brand in listOf("msdh", "msix")) {
            stypPayload.write(brand.toByteArray(Charsets.US_ASCII))
        }

        // ★ 分片 = styp + moof + mdat。moof 这个盒子本身别漏（漏了的话解析方
        //   会把 mfhd/traf 当成顶层盒子，trun 的 data_offset 也就全错位）
        val out = ByteArrayOutputStream()
        out.write(box("styp", stypPayload.toByteArray()))
        out.write(box("moof", body.toByteArray()))
        out.write(box("mdat", mdat.toByteArray()))
        return out.toByteArray()
    }

    /** 视频样本：时长按 DTS 间隔算，dts 平移到全流原点 */
    private fun finalizedVideo(samples: List<Sample>, origin: Long): List<Sample> {
        if (samples.isEmpty()) return emptyList()
        val out = samples.map { Sample(it.data, it.dts, it.duration, it.cts, it.isSync) }
        for (i in 0 until out.size - 1) {
            out[i].duration = maxOf(1L, out[i + 1].dts - out[i].dts)
        }
        // 最后一个样本的时长要等下一片才知道，先沿用上一个的
        out[out.size - 1].duration =
            if (out.size >= 2) out[out.size - 2].duration else 3000L
        for (sample in out) sample.dts = maxOf(0L, sample.dts - origin)
        return out
    }

    /** 音频样本：时基已经是「相对全流原点的采样数」，时长固定 1024 */
    private fun finalizedAudio(samples: List<Sample>): List<Sample> {
        val out = samples.map { Sample(it.data, it.dts, it.duration, it.cts, it.isSync) }
        for (sample in out) if (sample.duration <= 0) sample.duration = 1024
        return out
    }

    // ---------------------------------------------------------------- 盒子小工具

    private fun concat(chunks: List<ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        for (chunk in chunks) out.write(chunk, 0, chunk.size)
        return out.toByteArray()
    }

    private fun uint16(value: Int): ByteArray =
        byteArrayOf(((value shr 8) and 0xFF).toByte(), (value and 0xFF).toByte())

    private fun uint32(value: Long): ByteArray = byteArrayOf(
        ((value shr 24) and 0xFF).toByte(),
        ((value shr 16) and 0xFF).toByte(),
        ((value shr 8) and 0xFF).toByte(),
        (value and 0xFF).toByte(),
    )

    private fun int32(value: Int): ByteArray = uint32(value.toLong() and 0xFFFFFFFFL)

    private fun uint64(value: Long): ByteArray {
        val out = ByteArray(8)
        for (n in 0 until 8) {
            out[n] = ((value ushr (56 - n * 8)) and 0xFF).toByte()
        }
        return out
    }

    private fun box(type: String, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(uint32((payload.size + 8).toLong()))
        out.write(type.toByteArray(Charsets.US_ASCII))
        out.write(payload, 0, payload.size)
        return out.toByteArray()
    }

    private fun fullBox(type: String, version: Int, flags: Long, payload: ByteArray): ByteArray {
        val body = ByteArrayOutputStream()
        body.write(version and 0xFF)
        body.write(((flags shr 16) and 0xFF).toInt())
        body.write(((flags shr 8) and 0xFF).toInt())
        body.write((flags and 0xFF).toInt())
        body.write(payload, 0, payload.size)
        return box(type, body.toByteArray())
    }

    private fun mvhd(nextTrackId: Long): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(uint32(0)) // creation_time
        payload.write(uint32(0)) // modification_time
        payload.write(uint32(1000)) // timescale
        payload.write(uint32(0)) // duration
        payload.write(uint32(0x00010000)) // rate
        payload.write(uint16(0x0100)) // volume
        payload.write(uint16(0)) // reserved
        payload.write(uint32(0))
        payload.write(uint32(0))
        for (value in IDENTITY_MATRIX) payload.write(uint32(value))
        for (n in 0 until 6) payload.write(uint32(0))
        payload.write(uint32(nextTrackId))
        return fullBox("mvhd", 0, 0, payload.toByteArray())
    }

    private fun tkhdPayload(trackId: Long, width: Int, height: Int): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(uint32(0)) // creation_time
        payload.write(uint32(0)) // modification_time
        payload.write(uint32(trackId))
        payload.write(uint32(0)) // reserved
        payload.write(uint32(0)) // duration
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(uint16(0)) // layer
        payload.write(uint16(0)) // alternate_group
        payload.write(uint16(0)) // volume
        payload.write(uint16(0)) // reserved
        for (value in IDENTITY_MATRIX) payload.write(uint32(value))
        payload.write(uint32(width.toLong() shl 16))
        payload.write(uint32(height.toLong() shl 16))
        return payload.toByteArray()
    }

    private fun mdhdBox(timescale: Long): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(uint32(0)) // creation_time
        payload.write(uint32(0)) // modification_time
        payload.write(uint32(timescale))
        payload.write(uint32(0)) // duration
        payload.write(uint16(0x55C4)) // language = 'und'
        payload.write(uint16(0)) // pre_defined
        return fullBox("mdhd", 0, 0, payload.toByteArray())
    }

    private fun handlerBox(kind: String, name: String): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(uint32(0)) // pre_defined
        payload.write(kind.toByteArray(Charsets.US_ASCII))
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(name.toByteArray(Charsets.US_ASCII))
        payload.write(0)
        return fullBox("hdlr", 0, 0, payload.toByteArray())
    }

    private fun dinfBox(): ByteArray {
        val url = fullBox("url ", 0, 1, ByteArray(0))
        val dref = fullBox("dref", 0, 0, uint32(1) + url)
        return box("dinf", dref)
    }

    private fun stblBox(sampleEntry: ByteArray): ByteArray {
        val stsd = fullBox("stsd", 0, 0, uint32(1) + sampleEntry)
        val stts = fullBox("stts", 0, 0, uint32(0))
        val stsc = fullBox("stsc", 0, 0, uint32(0))
        val stsz = fullBox("stsz", 0, 0, uint32(0) + uint32(0))
        val stco = fullBox("stco", 0, 0, uint32(0))
        val body = ByteArrayOutputStream()
        body.write(stsd)
        body.write(stts)
        body.write(stsc)
        body.write(stsz)
        body.write(stco)
        return box("stbl", body.toByteArray())
    }

    private fun hvc1Entry(width: Int, height: Int, hvcC: ByteArray): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(ByteArray(6)) // reserved
        payload.write(uint16(1)) // data_reference_index
        payload.write(uint16(0)) // pre_defined
        payload.write(uint16(0)) // reserved
        payload.write(uint32(0)) // pre_defined[3]
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(uint16(width))
        payload.write(uint16(height))
        payload.write(uint32(0x00480000)) // horizresolution 72dpi
        payload.write(uint32(0x00480000)) // vertresolution
        payload.write(uint32(0)) // reserved
        payload.write(uint16(1)) // frame_count
        payload.write(ByteArray(32)) // compressorname
        payload.write(uint16(0x0018)) // depth
        payload.write(uint16(0xFFFF)) // pre_defined = -1
        payload.write(hvcC)
        return box("hvc1", payload.toByteArray())
    }

    private fun mp4aEntry(sampleRate: Int, channels: Int, asc: ByteArray): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(ByteArray(6))
        payload.write(uint16(1)) // data_reference_index
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(uint16(channels))
        payload.write(uint16(16)) // samplesize
        payload.write(uint16(0)) // pre_defined
        payload.write(uint16(0)) // reserved
        payload.write(uint32(sampleRate.toLong() shl 16))

        // esds: ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo(ASC) > SLConfig
        val dsi = ByteArrayOutputStream()
        dsi.write(0x05)
        dsi.write(asc.size)
        dsi.write(asc, 0, asc.size)

        val decoderConfig = ByteArrayOutputStream()
        decoderConfig.write(0x40)
        decoderConfig.write(0x15) // MPEG-4 Audio / streamType 5
        decoderConfig.write(0x00) // bufferSizeDB
        decoderConfig.write(0x00)
        decoderConfig.write(0x00)
        decoderConfig.write(uint32(0)) // maxBitrate
        decoderConfig.write(uint32(0)) // avgBitrate
        decoderConfig.write(dsi.toByteArray())
        decoderConfig.write(byteArrayOf(0x06, 0x01, 0x02)) // SLConfig

        val dcd = ByteArrayOutputStream()
        dcd.write(0x04)
        dcd.write(decoderConfig.size())
        dcd.write(decoderConfig.toByteArray())

        val es = ByteArrayOutputStream()
        es.write(uint16(1)) // ES_ID
        es.write(0) // flags
        es.write(dcd.toByteArray())

        val esd = ByteArrayOutputStream()
        esd.write(0x03)
        esd.write(es.size())
        esd.write(es.toByteArray())

        payload.write(fullBox("esds", 0, 0, esd.toByteArray()))
        return box("mp4a", payload.toByteArray())
    }

    /**
     * `avc1` 样本条目（VisualSampleEntry）。字段布局跟 `hvc1` **完全一样**，
     * 只是盒名不同、末尾挂的是 `avcC` 而不是 `hvcC`。
     */
    private fun avc1Entry(width: Int, height: Int, avcC: ByteArray): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(ByteArray(6)) // reserved
        payload.write(uint16(1)) // data_reference_index
        payload.write(uint16(0)) // pre_defined
        payload.write(uint16(0)) // reserved
        payload.write(uint32(0)) // pre_defined[3]
        payload.write(uint32(0))
        payload.write(uint32(0))
        payload.write(uint16(width))
        payload.write(uint16(height))
        payload.write(uint32(0x00480000)) // horizresolution 72dpi
        payload.write(uint32(0x00480000)) // vertresolution
        payload.write(uint32(0)) // reserved
        payload.write(uint16(1)) // frame_count
        payload.write(ByteArray(32)) // compressorname
        payload.write(uint16(0x0018)) // depth
        payload.write(uint16(0xFFFF)) // pre_defined = -1
        payload.write(avcC)
        return box("avc1", payload.toByteArray())
    }

    private fun buildHvcC(vps: List<ByteArray>, sps: List<ByteArray>, pps: List<ByteArray>, params: VideoParams): ByteArray {
        val payload = ByteArrayOutputStream()
        payload.write(1) // configurationVersion
        payload.write(params.ptl, 0, params.ptl.size) // 12 字节 PTL
        payload.write(uint16(0xF000)) // min_spatial_segmentation_idc
        payload.write(0xFC) // parallelismType = 0
        payload.write(0xFC or (params.chromaFormat and 0x03))
        payload.write(0xF8 or ((params.bitDepthLuma - 8) and 0x07))
        payload.write(0xF8 or ((params.bitDepthChroma - 8) and 0x07))
        payload.write(uint16(0)) // avgFrameRate
        // constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) | lengthSizeMinusOne(2)
        val layers = minOf(7, params.temporalLayers) and 0x07
        val nested = if (params.temporalIdNested) 0x04 else 0
        payload.write((layers shl 3) or nested or 0x03)

        val arrays = listOf(0x20 to vps, 0x21 to sps, 0x22 to pps)
        payload.write(arrays.size) // numOfArrays

        for ((type, nals) in arrays) {
            payload.write(type)
            payload.write(uint16(nals.size))
            for (nal in nals) {
                payload.write(uint16(nal.size))
                payload.write(nal, 0, nal.size)
            }
        }
        return box("hvcC", payload.toByteArray())
    }

    companion object {
        /**
         * 从**一段（可以不完整）** TS 里嗅出视频流的 stream_type。
         *
         * 用途：转封装探测先只要前 64KB —— PAT/PMT 就在 TS 最前面，判出不是 HEVC
         * 就直接收手，不必为一个注定不转的线路白下一整片（H.264 才是绝大多数）。
         *
         * 返回 null = 这段里还没见到 PMT（太少 / 刚好错过），调用方按"不转"处理。
         */
        @JvmStatic
        fun videoStreamType(inTs: ByteArray): Int? {
            if (inTs.size < 188) return null
            var pmtPid = -1
            var packet = 0
            while ((packet + 1) * 188 <= inTs.size) {
                val base = packet * 188
                packet += 1
                if (inTs[base] != 0x47.toByte()) continue

                val pid = ((inTs[base + 1].toInt() and 0x1F) shl 8) or (inTs[base + 2].toInt() and 0xFF)
                if ((inTs[base + 1].toInt() and 0x40) == 0) continue // 只要 PSI/section 起始包

                var offset = base + 4
                val adaptationControl = (inTs[base + 3].toInt() shr 4) and 0x3
                if (adaptationControl == 2 || adaptationControl == 3) {
                    offset += 1 + (inTs[offset].toInt() and 0xFF)
                }
                if (offset >= base + 188) continue

                // 净荷第一个字节是 pointer_field，之后才是 section
                val sectionStart = offset + 1 + (inTs[offset].toInt() and 0xFF)
                if (sectionStart >= base + 188) continue

                if (pid == 0 && pmtPid < 0) {
                    pmtPid = probePat(inTs, sectionStart, base + 188) ?: -1
                    continue
                }
                if (pmtPid >= 0 && pid == pmtPid) {
                    for (stream in probePmt(inTs, sectionStart, base + 188)) {
                        if (isVideoStreamType(stream.type)) return stream.type
                    }
                }
            }
            return null
        }

        private fun probePat(bytes: ByteArray, start: Int, limit: Int): Int? {
            if (start + 8 >= limit) return null
            if (bytes[start] != 0.toByte()) return null
            val sectionLength = ((bytes[start + 1].toInt() and 0x0F) shl 8) or (bytes[start + 2].toInt() and 0xFF)
            val end = minOf(limit, start + 3 + sectionLength - 4)
            var i = start + 8
            while (i + 3 < end) {
                val program = ((bytes[i].toInt() and 0xFF) shl 8) or (bytes[i + 1].toInt() and 0xFF)
                val pid = ((bytes[i + 2].toInt() and 0x1F) shl 8) or (bytes[i + 3].toInt() and 0xFF)
                if (program != 0) return pid
                i += 4
            }
            return null
        }

        private fun probePmt(bytes: ByteArray, start: Int, limit: Int): List<PmtEntry> {
            if (start + 12 >= limit) return emptyList()
            if (bytes[start] != 0x02.toByte()) return emptyList()
            val sectionLength = ((bytes[start + 1].toInt() and 0x0F) shl 8) or (bytes[start + 2].toInt() and 0xFF)
            val programInfoLength = ((bytes[start + 10].toInt() and 0x0F) shl 8) or (bytes[start + 11].toInt() and 0xFF)
            val end = minOf(limit, start + 3 + sectionLength - 4)
            var i = start + 12 + programInfoLength
            val out = mutableListOf<PmtEntry>()
            while (i + 4 < end) {
                val type = bytes[i].toInt() and 0xFF
                val pid = ((bytes[i + 1].toInt() and 0x1F) shl 8) or (bytes[i + 2].toInt() and 0xFF)
                val esInfoLength = ((bytes[i + 3].toInt() and 0x0F) shl 8) or (bytes[i + 4].toInt() and 0xFF)
                out.add(PmtEntry(type, pid))
                i += 5 + esInfoLength
            }
            return out
        }

        /** 常见视频 stream_type（ISO/IEC 13818-1 表 2-34） */
        fun isVideoStreamType(type: Int): Boolean = when (type) {
            0x01, 0x02, 0x10, 0x1B, 0x24, 0x42, 0xEA -> true
            else -> false
        }

        /**
         * H.264 里"高 profile"的那一批（ITU-T H.264 表 A-1）。
         *
         * ★ 它们的 SPS 多出 chroma_format_idc / 位深 / 缩放矩阵一整段 ——
         *   不按这个分流的话，后面的位读全错位。
         */
        private val HIGH_PROFILES = intArrayOf(
            100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
        )

        /** ADTS 采样率表（ISO/IEC 13818-7） */
        private val SAMPLE_RATES = intArrayOf(
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
            16000, 12000, 11025, 8000, 7350,
        )

        /** tkhd / mvhd 的单位矩阵（16.16 / 2.30 定点） */
        private val IDENTITY_MATRIX = listOf(
            0x00010000L, 0L, 0L,
            0L, 0x00010000L, 0L,
            0L, 0L, 0x40000000L,
        )
    }
}

/**
 * 大端位读取器（HEVC SPS 用）。`skipping` 用来跳过 2 字节 NAL 头。
 *
 * ★ 读之前会先剥掉防竞争字节（00 00 03 -> 00 00），否则位对齐会错。
 */
private class BitReader(data: ByteArray, skipping: Int) {
    private val bytes: ByteArray
    private var bitIndex: Int

    init {
        val cleaned = ByteArrayOutputStream()
        var zeroCount = 0
        for (byte in data) {
            if (zeroCount >= 2 && byte == 0x03.toByte()) {
                zeroCount = 0
                continue
            }
            cleaned.write(byte.toInt() and 0xFF)
            zeroCount = if (byte == 0.toByte()) zeroCount + 1 else 0
        }
        bytes = cleaned.toByteArray()
        bitIndex = skipping * 8
    }

    private fun readBit(): Boolean? {
        if (bitIndex >= bytes.size * 8) return null
        val byte = bytes[bitIndex shr 3].toInt() and 0xFF
        val shift = 7 - (bitIndex and 7)
        val bit = (byte shr shift) and 0x01
        bitIndex += 1
        return bit == 1
    }

    fun readFlag(): Boolean =
        readBit() ?: throw TsFmp4Remuxer.RemuxException("TS 结构异常：SPS 读越界")

    fun readBits(count: Int): Long {
        var value = 0L
        for (n in 0 until count) {
            val bit = readBit() ?: throw TsFmp4Remuxer.RemuxException("TS 结构异常：SPS 读越界")
            value = (value shl 1) or (if (bit) 1L else 0L)
        }
        return value
    }

    fun skipBits(count: Int) {
        if (bitIndex + count > bytes.size * 8) {
            throw TsFmp4Remuxer.RemuxException("TS 结构异常：SPS 读越界")
        }
        bitIndex += count
    }

    /** 有符号指数哥伦布（H.264 的 offset_for_* 那几个字段要用） */
    fun readSE(): Long {
        val ue = readUE()
        return if (ue and 1L == 1L) (ue + 1) / 2 else -((ue + 1) / 2)
    }

    fun readUE(): Long {
        var leadingZeros = 0
        while (true) {
            val bit = readBit() ?: throw TsFmp4Remuxer.RemuxException("TS 结构异常：SPS 读越界")
            if (bit) break
            leadingZeros += 1
            if (leadingZeros > 31) {
                throw TsFmp4Remuxer.RemuxException("TS 结构异常：SPS exp-golomb 越界")
            }
        }
        if (leadingZeros == 0) return 0
        val rest = readBits(leadingZeros)
        return ((1L shl leadingZeros) - 1) + rest
    }
}
