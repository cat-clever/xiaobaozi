import Foundation

/**
 * MPEG-TS（HEVC + AAC）→ fMP4 转封装。
 *
 * ★ 为什么需要它（改动记录第二十六轮）：
 *   AVFoundation 的 MPEG-TS 解封装**根本不认 HEVC**，AVPlayer 会静默丢掉视频轨 ——
 *   表现是「有声音、黑屏」。而源1 有少数线路正是 HEVC 装在 TS 里
 *   （实测「星汉灿烂\月升沧海」：`mpegts | hevc Main 864x368 + aac`，
 *    同一目录下所有 index 都是 HEVC，没有 H.264 备选）。
 *   Apple 的 HLS 规范也写死了 HEVC 的容器 **MUST be fMP4**。
 *
 * 这个类只做**转封装**（remux，不重新编码）：视频码流一个字节都不改，只换容器。
 *   TS 分片（HEVC Annex-B + AAC ADTS）→ fMP4（hvc1 + mp4a，moov / moof+mdat）
 *
 * ★ 故意只支持「恰好这一种」输入，别的宁可抛错回退（回退后仍是原来的黑屏，
 *   但绝不会给出半成品让播放器卡住）：
 *   - 视频：HEVC（stream_type 0x24）
 *   - 音频：AAC ADTS（stream_type 0x0F；LATM 不支持）
 *   - 无加密、无 EXT-X-BYTERANGE、无 EXT-X-DISCONTINUITY
 *
 * 语义与 ffmpeg 的 `-c copy -f mp4 -movflags frag_keyframe+empty_moov` 同类，
 * 但**不用 AVFoundation**（它读不了这条流，见上）。
 *
 * 用法（本地媒体服务里，一个流一个实例，跨分片保留时间轴原点）：
 *   let r = TsFmp4Remuxer()
 *   let frag = try r.remux(segment: firstSegmentData)   // 参数集 / ASC 都从它来
 *   let init = try r.initSegment()                      // 给播放器的 #EXT-X-MAP
 *   let frag2 = try r.remux(segment: secondSegmentData) // 其余分片，逐片转
 */
final class TsFmp4Remuxer {

  enum RemuxError: Error, CustomStringConvertible {
    case notTransportStream
    case noVideoStream
    case unsupportedVideo(String)
    case noAudioStream
    case unsupportedAudio(String)
    case malformed(String)

    var description: String {
      switch self {
      case .notTransportStream: return "不是 MPEG-TS"
      case .noVideoStream: return "这条流里没有视频轨"
      case .unsupportedVideo(let what): return "视频编码不支持转封装：\(what)"
      case .noAudioStream: return "这条流里没有音频轨"
      case .unsupportedAudio(let what): return "音频编码不支持转封装：\(what)"
      case .malformed(let what): return "TS 结构异常：\(what)"
      }
    }
  }

  // MARK: - 内部模型

  /// 一个待写入的样本（时间戳单位是该轨的时基；dts 已减去 tfdt 原点）
  private struct Sample {
    var data: Data
    var dts: Int64
    var duration: Int64
    /// PTS - DTS（有 B 帧才非 0）
    var cts: Int64
    var isSync: Bool
  }

  /// 一条轨道跨分片保留的信息
  private struct Track {
    let id: UInt32
    let timescale: UInt32
  }

  private var videoTrack: Track?
  private var audioTrack: Track?

  /// 全流时间轴原点（90kHz）：视频首 DTS 与音频首 PTS 取小。
  ///
  /// ★ 两轨必须共用同一个原点，否则会丢掉**音视频彼此的初始偏移**。
  ///   实测这条流第一帧的 cts = 14400（0.16s），音频首帧 PTS 正好落在那儿；
  ///   各归一化各的就会让声音提前 0.16 秒。
  private var origin90k: Int64?

  /// 视频参数集（造 hvcC 用）。都是**列表** —— 这条流带了 4 个 PPS，
  /// 只留第一个的话解码器可能找不到被引用的那个。
  private var vpsNals: [Data] = []
  private var spsNals: [Data] = []
  private var ppsNals: [Data] = []
  private var videoSize: (width: Int, height: Int)?
  private var videoParams: VideoParams?
  /// AAC 的 AudioSpecificConfig（从 ADTS 头解析）
  private var audioAsc: Data?
  private var audioSampleRate = 44100
  private var audioChannels = 2

  private var sequence: UInt32 = 0
  private var cachedInit: Data?

  private struct VideoParams {
    var chromaFormat: Int
    var bitDepthLuma: Int
    var bitDepthChroma: Int
    /// hvcC 的头 12 字节（general_profile_space … general_level_idc）
    var ptl: Data
    /// sps_max_sub_layers_minus1 + 1
    var temporalLayers: Int
    var temporalIdNested: Bool
  }

  /// 转封装过至少一个分片没有（init 要等第一个分片才知道参数集）
  var hasInit: Bool { cachedInit != nil }

  // MARK: - 对外

  /// 把一片 TS 转成一片 fMP4（moof + mdat）。第一次调用时顺便把 init 备好
  @discardableResult
  func remux(segment: Data) throws -> Data {
    let demuxed = try demux(segment)
    let videoSamples = try buildVideoSamples(demuxed.videoPes)

    // 全流原点第一片时定下来：视频首 DTS 与音频首 PTS 取小（见 origin90k 的注释）
    if origin90k == nil {
      let videoFirst = videoSamples.first?.dts ?? 0
      let audioFirst = demuxed.audioPes.first(where: { $0.pts != nil })?.pts ?? videoFirst
      origin90k = min(videoFirst, audioFirst)
    }
    let origin = origin90k ?? 0

    let audioSamples = try buildAudioSamples(demuxed.audioPes, origin90k: origin)
    guard !videoSamples.isEmpty else { throw RemuxError.malformed("这片里没有视频样本") }

    if videoTrack == nil {
      videoTrack = Track(id: 1, timescale: 90000)
      audioTrack = Track(id: 2, timescale: UInt32(audioSampleRate))
    }
    if cachedInit == nil { cachedInit = try buildInitSegment() }

    sequence += 1
    return try buildFragment(video: videoSamples, audio: audioSamples, origin: origin)
  }

  /// `#EXT-X-MAP` 指向的初始化段（要在 `remux` 之后调）
  func initSegment() throws -> Data {
    guard let cachedInit else { throw RemuxError.malformed("还没有喂过任何分片") }
    return cachedInit
  }

  // MARK: - TS 解复用

  private struct Pes {
    var pts: Int64?
    var dts: Int64?
    var payload: Data
  }

  private struct Demuxed {
    var videoPes: [Pes]
    var audioPes: [Pes]
  }

  /// 扫一遍 TS，把视频/音频的 PES 收齐（184 字节净荷跨包重组，按 PES 长度裁掉填充）
  private func demux(_ data: Data) throws -> Demuxed {
    let packetCount = data.count / 188
    let bytes = [UInt8](data)
    guard packetCount > 0, bytes[0] == 0x47 else { throw RemuxError.notTransportStream }

    var pmtPid = -1
    var videoPid = -1
    var audioPid = -1
    var videoType: UInt8 = 0
    var audioType: UInt8 = 0

    var videoPes: [Pes] = []
    var audioPes: [Pes] = []

    // 每个 PID 正在拼的 PES
    var partial: [Int: Data] = [:]
    var partialRemaining: [Int: Int] = [:]   // -1 = PES 长度未知
    var partialPts: [Int: Int64] = [:]
    var partialDts: [Int: Int64] = [:]

    func flush(_ pid: Int) {
      guard let body = partial[pid], !body.isEmpty else {
        partial[pid] = nil
        partialRemaining[pid] = nil
        return
      }
      let pes = Pes(pts: partialPts[pid], dts: partialDts[pid], payload: body)
      if pid == videoPid { videoPes.append(pes) } else if pid == audioPid { audioPes.append(pes) }
      partial[pid] = nil
      partialRemaining[pid] = nil
    }

    for index in 0..<packetCount {
      let base = index * 188
      // 对齐就整条对齐；中途错位就放弃这片（宁可回退到原 TS）
      guard bytes[base] == 0x47 else { throw RemuxError.malformed("第 \(index) 包没有同步字节") }

      let pid = (Int(bytes[base + 1] & 0x1F) << 8) | Int(bytes[base + 2])
      let payloadStart = bytes[base + 1] & 0x40 != 0
      let adaptationControl = (bytes[base + 3] >> 4) & 0x03

      var offset = base + 4
      if adaptationControl == 2 || adaptationControl == 3 {
        let length = Int(bytes[offset])
        offset += 1 + length
        if adaptationControl == 2 { continue }   // 只有适配域，没有净荷
      }
      guard offset < base + 188 else { continue }

      // PAT / PMT：净荷第一个字节是 pointer_field，之后才是 section
      if pid == 0 {
        if payloadStart {
          let pointer = Int(bytes[offset])
          let sectionStart = offset + 1 + pointer
          if sectionStart < base + 188, let mapPid = Self.parsePat(bytes, sectionStart..<(base + 188)) {
            pmtPid = mapPid
          }
        }
        continue
      }

      if pmtPid >= 0 && pid == pmtPid {
        if payloadStart {
          let pointer = Int(bytes[offset])
          let sectionStart = offset + 1 + pointer
          if sectionStart < base + 188 {
            let streams = Self.parsePmt(bytes, sectionStart..<(base + 188))
            for stream in streams {
              switch stream.type {
              case 0x0F, 0x11:
                audioPid = stream.pid; audioType = stream.type
              default:
                // 视频流一律记下来（**含不支持的编码**）—— 后面才能如实报
                // "不支持 HEVC 以外的编码"，而不是误报"没有视频轨"
                if Self.isVideoStreamType(stream.type), videoPid < 0 {
                  videoPid = stream.pid; videoType = stream.type
                }
              }
            }
          }
        }
        continue
      }

      guard pid == videoPid || pid == audioPid else { continue }

      let payload = Data(bytes[offset..<(base + 188)])
      if payloadStart {
        flush(pid)
        // PES 头：00 00 01 <stream_id>
        guard payload.count >= 9, payload[0] == 0, payload[1] == 0, payload[2] == 1 else { continue }
        let pesLength = (Int(payload[4]) << 8) | Int(payload[5])
        let flags = payload[7]
        let headerDataLength = Int(payload[8])
        var pts: Int64?
        var dts: Int64?
        if flags & 0x80 != 0 {
          pts = Self.readTimestamp(payload, at: 9)
          if flags & 0x40 != 0 { dts = Self.readTimestamp(payload, at: 14) }
        }
        let bodyStart = 9 + headerDataLength
        guard bodyStart <= payload.count else { continue }
        var body = Data(payload[bodyStart...])
        var remaining = -1
        if pesLength != 0 {
          // PES 总长 = 6 + pesLength；净荷 = 总长 - 6 - 3 - headerDataLength
          remaining = max(0, pesLength - 3 - headerDataLength)
          if body.count > remaining { body = body.prefix(remaining) }
        }
        partial[pid] = body
        partialRemaining[pid] = remaining >= 0 ? remaining - body.count : -1
        if let pts { partialPts[pid] = pts } else { partialPts[pid] = nil }
        if let dts { partialDts[pid] = dts } else { partialDts[pid] = nil }
      } else if var existing = partial[pid] {
        var chunk = payload
        let remaining = partialRemaining[pid] ?? -1
        if remaining == 0 { continue }                 // 这段全是填充
        if remaining > 0 && chunk.count > remaining { chunk = chunk.prefix(remaining) }
        existing.append(chunk)
        partial[pid] = existing
        if remaining > 0 { partialRemaining[pid] = remaining - chunk.count }
      }
    }

    if videoPid < 0 { throw RemuxError.noVideoStream }
    if videoType != 0x24 {
      throw RemuxError.unsupportedVideo(String(format: "stream_type=0x%02X（只支持 HEVC 0x24）", videoType))
    }
    if audioPid < 0 { throw RemuxError.noAudioStream }
    if audioType != 0x0F {
      throw RemuxError.unsupportedAudio(String(format: "stream_type=0x%02X（只支持 AAC ADTS 0x0F）", audioType))
    }
    flush(videoPid)
    flush(audioPid)

    return Demuxed(videoPes: videoPes, audioPes: audioPes)
  }

  /// PES 头里的 5 字节时间戳（33 位 @90kHz）。`offset` 相对 `data.startIndex`
  private static func readTimestamp(_ data: Data, at offset: Int) -> Int64 {
    let base = data.startIndex + offset
    guard base + 4 < data.endIndex else { return 0 }
    let a = Int64(data[base] & 0x0E) << 29
    let b = Int64(data[base + 1]) << 22
    let c = Int64(data[base + 2] & 0xFE) << 14
    let d = Int64(data[base + 3]) << 7
    let e = Int64(data[base + 4] >> 1)
    return a | b | c | d | e
  }

  /// PAT → PMT 的 PID（`start` 是 section 起点，已跳过 pointer_field）
  private static func parsePat(_ bytes: [UInt8], _ range: Range<Int>) -> Int? {
    guard range.lowerBound + 8 < range.upperBound else { return nil }
    let start = range.lowerBound
    guard bytes[start] == 0x00 else { return nil }
    let sectionLength = (Int(bytes[start + 1] & 0x0F) << 8) | Int(bytes[start + 2])
    let end = min(range.upperBound, start + 3 + sectionLength - 4)
    var i = start + 8
    while i + 3 < end {
      let program = (Int(bytes[i]) << 8) | Int(bytes[i + 1])
      let pid = (Int(bytes[i + 2] & 0x1F) << 8) | Int(bytes[i + 3])
      if program != 0 { return pid }
      i += 4
    }
    return nil
  }

  /// PMT → (stream_type, elementary_PID) 列表
  private static func parsePmt(_ bytes: [UInt8], _ range: Range<Int>) -> [(type: UInt8, pid: Int)] {
    guard range.lowerBound + 12 < range.upperBound else { return [] }
    let start = range.lowerBound
    guard bytes[start] == 0x02 else { return [] }
    let sectionLength = (Int(bytes[start + 1] & 0x0F) << 8) | Int(bytes[start + 2])
    let programInfoLength = (Int(bytes[start + 10] & 0x0F) << 8) | Int(bytes[start + 11])
    let end = min(range.upperBound, start + 3 + sectionLength - 4)
    var i = start + 12 + programInfoLength
    var out: [(UInt8, Int)] = []
    while i + 4 < end {
      let type = bytes[i]
      let pid = (Int(bytes[i + 1] & 0x1F) << 8) | Int(bytes[i + 2])
      let esInfoLength = (Int(bytes[i + 3] & 0x0F) << 8) | Int(bytes[i + 4])
      out.append((type, pid))
      i += 5 + esInfoLength
    }
    return out
  }

  /// 从**一段（可以不完整）** TS 里嗅出视频流的 stream_type。
  ///
  /// 用途：转封装探测先只要前 64KB —— PAT/PMT 就在 TS 最前面，判出不是 HEVC
  /// 就直接收手，不必为一个注定不转的线路白下一整片（H.264 才是绝大多数）。
  ///
  /// 返回 nil = 这段里还没见到 PMT（太少 / 刚好错过），调用方按"不转"处理。
  static func videoStreamType(inTs data: Data) -> UInt8? {
    let bytes = [UInt8](data)
    guard bytes.count >= 188 else { return nil }

    var pmtPid: Int?
    var packet = 0
    while (packet + 1) * 188 <= bytes.count {
      let base = packet * 188
      packet += 1
      guard bytes[base] == 0x47 else { continue }

      let pid = (Int(bytes[base + 1] & 0x1F) << 8) | Int(bytes[base + 2])
      guard bytes[base + 1] & 0x40 != 0 else { continue }   // 只要 PSI/section 起始包

      var offset = base + 4
      let adaptationControl = (bytes[base + 3] >> 4) & 0x3
      if adaptationControl == 2 || adaptationControl == 3 {
        offset += 1 + Int(bytes[offset])
      }
      guard offset < base + 188 else { continue }

      // 净荷第一个字节是 pointer_field，之后才是 section
      let sectionStart = offset + 1 + Int(bytes[offset])
      guard sectionStart < base + 188 else { continue }

      if pid == 0, pmtPid == nil {
        pmtPid = Self.parsePat(bytes, sectionStart..<(base + 188))
        continue
      }
      if let pmtPid, pid == pmtPid {
        let streams = Self.parsePmt(bytes, sectionStart..<(base + 188))
        for stream in streams where Self.isVideoStreamType(stream.type) {
          return stream.type
        }
      }
    }
    return nil
  }

  /// 常见视频 stream_type（ISO/IEC 13818-1 表 2-34）
  private static func isVideoStreamType(_ type: UInt8) -> Bool {
    switch type {
    case 0x01, 0x02, 0x10, 0x1B, 0x24, 0x42, 0xEA: return true
    default: return false
    }
  }

  // MARK: - Annex-B / NAL

  /// 按起始码切 NAL。**只返回已被下一个起始码终结的 NAL**；
  /// 从最后一个起始码起的那段（可能还没收完）原样返回，留给下一次或片尾。
  ///
  /// ★ 第一版把"最后一段"既当成完整 NAL 又在 carry 里留着，于是
  ///   跨 PES 的 NAL 会被截断、尾巴丢掉（转出来的样本就散了）。
  ///
  /// HEVC 的 NAL 头是两字节：type = (b0 >> 1) & 0x3F
  private static func splitAnnexB(_ buffer: Data) -> (nals: [Data], rest: Data) {
    let bytes = [UInt8](buffer)
    var starts: [Int] = []
    var i = 0
    while i + 2 < bytes.count {
      if bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 {
        starts.append(i)
        i += 3
      } else {
        i += 1
      }
    }
    guard starts.count >= 2 else { return ([], buffer) }
    var nals: [Data] = []
    for n in 0..<(starts.count - 1) {
      let from = starts[n] + 3
      let to = starts[n + 1]
      guard to > from else { continue }
      var slice = [UInt8](bytes[from..<to])
      // 4 字节起始码会在上一段末尾留一个 0x00；Annex-B 的尾部补零也不属于 NAL
      while let last = slice.last, last == 0 { slice.removeLast() }
      if !slice.isEmpty { nals.append(Data(slice)) }
    }
    // 最后一个起始码之后的部分（含起始码本身）留到下一次
    return (nals, Data(bytes[starts[starts.count - 1]...]))
  }

  /// 片尾用：carry 里那个"没被下一个起始码终结"的 NAL 其实已经完整了，取出来
  private static func trailingNal(_ carry: Data) -> Data? {
    let bytes = [UInt8](carry)
    guard bytes.count > 3, bytes[0] == 0, bytes[1] == 0, bytes[2] == 1 else { return nil }
    var slice = [UInt8](bytes[3...])
    while let last = slice.last, last == 0 { slice.removeLast() }
    return slice.isEmpty ? nil : Data(slice)
  }

  private static func nalType(_ nal: Data) -> Int {
    guard nal.count >= 2 else { return -1 }
    return Int((nal[nal.startIndex] >> 1) & 0x3F)
  }

  private static func isVcl(_ type: Int) -> Bool { type >= 0 && type <= 31 }
  private static func isIrap(_ type: Int) -> Bool { type >= 16 && type <= 23 }

  /// slice 头第一个 bit = first_slice_segment_in_pic_flag
  private static func startsNewPicture(_ nal: Data) -> Bool {
    guard nal.count >= 3 else { return false }
    var reader = BitReader(nal, skipping: 2)
    return (try? reader.readFlag()) == true
  }

  private func noteParameterSets(_ nal: Data, type: Int) {
    switch type {
    case 32: if !vpsNals.contains(nal) { vpsNals.append(nal) }
    case 33:
      if !spsNals.contains(nal) { spsNals.append(nal) }
      if videoSize == nil, let first = spsNals.first { parseSps(first) }
    case 34: if !ppsNals.contains(nal) { ppsNals.append(nal) }
    default: break
    }
  }

  // MARK: - 视频样本（按 AU 组装）

  private func buildVideoSamples(_ pesList: [Pes]) throws -> [Sample] {
    var samples: [Sample] = []
    var auNals: [Data] = []
    var auPts: Int64?
    var auDts: Int64?
    var auType = -1
    var carry = Data()

    func flushAu() {
      guard !auNals.isEmpty else { return }
      let pts = auPts ?? auDts ?? 0
      let dts = auDts ?? pts
      var payload = Data()
      for nal in auNals {
        let length = UInt32(nal.count)
        payload.append(UInt8((length >> 24) & 0xFF))
        payload.append(UInt8((length >> 16) & 0xFF))
        payload.append(UInt8((length >> 8) & 0xFF))
        payload.append(UInt8(length & 0xFF))
        payload.append(nal)
      }
      samples.append(Sample(data: payload, dts: dts, duration: 0, cts: pts - dts, isSync: Self.isIrap(auType)))
      auNals = []
      auType = -1
      auPts = nil
      auDts = nil
    }

    func handle(_ nal: Data, pesPts: Int64?, pesDts: Int64?) {
      let type = Self.nalType(nal)
      if auPts == nil { auPts = pesPts ?? pesDts; auDts = pesDts ?? pesPts }

      if type == 35 {                       // AUD：一个 AU 的明确分界
        if auNals.contains(where: { Self.isVcl(Self.nalType($0)) }) {
          flushAu()
          auPts = pesPts ?? pesDts
          auDts = pesDts ?? pesPts
        }
        auNals.append(nal)                  // ★ 留在样本里（参考实现也留）
        return
      }
      if Self.isVcl(type) {
        if Self.startsNewPicture(nal), auNals.contains(where: { Self.isVcl(Self.nalType($0)) }) {
          flushAu()
          auPts = pesPts ?? pesDts
          auDts = pesDts ?? pesPts
        }
        if auType < 0 { auType = type }     // 第一个 VCL 的类型决定这一 AU 是不是关键帧
      } else {
        noteParameterSets(nal, type: type)
      }
      auNals.append(nal)
    }

    var lastPesPts: Int64?
    var lastPesDts: Int64?
    for pes in pesList {
      // 带 PTS 的新 PES 就是新 AU（ffmpeg 多路复用下 1 个 PES = 1 个 AU；
      // 超大 AU 会被拆成多个 PES，只有第一个带 PTS）
      if pes.pts != nil, auNals.contains(where: { Self.isVcl(Self.nalType($0)) }) { flushAu() }

      var buffer = carry
      buffer.append(pes.payload)
      let (nals, rest) = Self.splitAnnexB(buffer)
      carry = rest
      if let pts = pes.pts { lastPesPts = pts }
      if let dts = pes.dts { lastPesDts = dts }

      for nal in nals { handle(nal, pesPts: pes.pts, pesDts: pes.dts) }
    }

    // 片尾：carry 里是最后一个 NAL（已完整，只是没有下一个起始码来终结它）
    if let last = Self.trailingNal(carry) {
      handle(last, pesPts: lastPesPts, pesDts: lastPesDts)
    }
    flushAu()
    return samples
  }

  // MARK: - 音频样本（ADTS）

  private static let sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

  private func buildAudioSamples(_ pesList: [Pes], origin90k: Int64) throws -> [Sample] {
    var buffer = Data()
    for pes in pesList { buffer.append(pes.payload) }
    guard !buffer.isEmpty else { return [] }

    // 第一帧的时间戳取第一个带 PTS 的 PES，再换算到音频时基（相对全流原点）；
    // 之后按 1024 采样累加。
    // ★ 这条流是 HE-AAC（ADTS 头写 24000 + 带内 SBR，解码后 48000）。
    //   我按 ADTS 头的时基如实声明 24000，每帧 1024 采样 ——
    //   换算成真实时长 42.67ms 与 SBR 的 2048@48000 完全一致，
    //   所以音画对得上；解码器认不认 SBR 只影响高频，不影响速度。
    var firstPts: Int64?
    for pes in pesList where pes.pts != nil { firstPts = pes.pts; break }

    let bytes = [UInt8](buffer)
    var samples: [Sample] = []
    var i = 0

    while i + 7 <= bytes.count {
      guard bytes[i] == 0xFF, (bytes[i + 1] & 0xF0) == 0xF0, (bytes[i + 1] & 0x06) == 0 else {
        i += 1
        continue
      }
      let protectionAbsent = bytes[i + 1] & 0x01 == 1
      let headerLength = protectionAbsent ? 7 : 9
      let profile = Int((bytes[i + 2] >> 6) & 0x03)
      let sampleRateIndex = Int((bytes[i + 2] >> 2) & 0x0F)
      let channelConfig = (Int(bytes[i + 2] & 0x01) << 2) | Int((bytes[i + 3] >> 6) & 0x03)
      let frameLength = (Int(bytes[i + 3] & 0x03) << 11) | (Int(bytes[i + 4]) << 3) | Int((bytes[i + 5] >> 5) & 0x07)
      guard frameLength > headerLength, i + frameLength <= bytes.count else { break }
      guard sampleRateIndex < Self.sampleRates.count else {
        throw RemuxError.unsupportedAudio("采样率索引 \(sampleRateIndex)")
      }

      if audioAsc == nil {
        audioSampleRate = Self.sampleRates[sampleRateIndex]
        audioChannels = channelConfig == 0 ? 2 : channelConfig
        let asc: UInt16 = UInt16((profile + 1) & 0x1F) << 11
          | UInt16(sampleRateIndex & 0x0F) << 7
          | UInt16(channelConfig & 0x0F) << 3
        audioAsc = Data([UInt8(asc >> 8), UInt8(asc & 0xFF)])
      }

      let dts: Int64
      if let last = samples.last {
        dts = last.dts + last.duration
      } else {
        dts = max(0, Self.rescale((firstPts ?? origin90k) - origin90k, from: 90000, to: Int64(audioSampleRate)))
      }

      samples.append(Sample(data: Data(bytes[(i + headerLength)..<(i + frameLength)]),
                            dts: dts, duration: 1024, cts: 0, isSync: true))
      i += frameLength
    }

    guard !samples.isEmpty else { throw RemuxError.unsupportedAudio("没解出 ADTS 帧") }
    return samples
  }

  private static func rescale(_ value: Int64, from: Int64, to: Int64) -> Int64 {
    guard from > 0 else { return value }
    return Int64((Double(value) * Double(to) / Double(from)).rounded())
  }

  // MARK: - SPS 解析（宽高 / 色度 / 位深 / PTL）

  private func parseSps(_ nal: Data) {
    var reader = BitReader(nal, skipping: 2)
    guard let videoParameterSetId = try? reader.readBits(4),
          let maxSubLayersMinus1Value = try? reader.readBits(3),
          let temporalIdNested = try? reader.readFlag()
    else { return }
    _ = videoParameterSetId
    let maxSubLayersMinus1 = Int(maxSubLayersMinus1Value)

    // profile_tier_level(1, maxSubLayersMinus1) —— 前 12 字节正好是 hvcC 要的那段
    var ptl = Data()
    for _ in 0..<12 {
      guard let byte = try? reader.readBits(8) else { return }
      ptl.append(UInt8(byte))
    }

    // 跳过子层的 profile/level 标志位，才能继续读 SPS 正文
    var subLayerProfile: [Bool] = []
    var subLayerLevel: [Bool] = []
    if maxSubLayersMinus1 > 0 {
      for _ in 0..<maxSubLayersMinus1 {
        guard let p = try? reader.readFlag(), let l = try? reader.readFlag() else { return }
        subLayerProfile.append(p)
        subLayerLevel.append(l)
      }
      guard reader.skipBits((8 - maxSubLayersMinus1) * 2) else { return }
      for index in 0..<maxSubLayersMinus1 {
        if subLayerProfile[index], !reader.skipBits(88) { return }
        if subLayerLevel[index], !reader.skipBits(8) { return }
      }
    }

    // ★ sps_seq_parameter_set_id 必须先读 —— 少读一个 ue 后面全部错位
    //   （第一版漏了它，结果 chromaFormat 读成 0[单色]、位深读成 15bit）
    guard let _ = try? reader.readUE(),                                   // sps_seq_parameter_set_id
          let chromaFormat = try? reader.readUE()
    else { return }
    if chromaFormat == 3, (try? reader.readFlag()) == nil { return }
    guard let width = try? reader.readUE(), let height = try? reader.readUE() else { return }

    var cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0
    if (try? reader.readFlag()) == true {
      cropLeft = (try? reader.readUE()).map(Int.init) ?? 0
      cropRight = (try? reader.readUE()).map(Int.init) ?? 0
      cropTop = (try? reader.readUE()).map(Int.init) ?? 0
      cropBottom = (try? reader.readUE()).map(Int.init) ?? 0
    }
    let bitDepthLuma = ((try? reader.readUE()).map(Int.init) ?? 0) + 8
    let bitDepthChroma = ((try? reader.readUE()).map(Int.init) ?? 0) + 8

    // 裁剪窗口换算成显示尺寸（SubWidthC / SubHeightC 由色度格式决定）
    let chroma = Int(chromaFormat)
    let subWidthC = (chroma == 1 || chroma == 2) ? 2 : 1
    let subHeightC = (chroma == 1) ? 2 : 1
    let displayWidth = Int(width) - (cropLeft + cropRight) * subWidthC
    let displayHeight = Int(height) - (cropTop + cropBottom) * subHeightC

    videoSize = (max(1, displayWidth), max(1, displayHeight))
    videoParams = VideoParams(chromaFormat: chroma,
                              bitDepthLuma: bitDepthLuma,
                              bitDepthChroma: bitDepthChroma,
                              ptl: ptl,
                              temporalLayers: max(1, maxSubLayersMinus1 + 1),
                              temporalIdNested: temporalIdNested)
  }

  // MARK: - init 段

  private func buildInitSegment() throws -> Data {
    guard !vpsNals.isEmpty, !spsNals.isEmpty, !ppsNals.isEmpty,
          let size = videoSize, let params = videoParams,
          let asc = audioAsc, let videoTrack, let audioTrack
    else { throw RemuxError.malformed("参数集 / 音频配置不齐，造不出 init") }

    let hvcC = Self.buildHvcC(vps: vpsNals, sps: spsNals, pps: ppsNals, params: params)

    var ftypPayload = Data("isom".utf8)
    ftypPayload.append(Self.uint32(512))
    for brand in ["isom", "iso5", "iso6", "mp41", "hvc1"] { ftypPayload.append(Data(brand.utf8)) }
    let ftyp = Self.box("ftyp", ftypPayload)

    let moov = Self.box("moov",
                        Self.mvhd(nextTrackId: 3)
                        + videoTrak(size: size, hvcC: hvcC, track: videoTrack)
                        + audioTrak(asc: asc, track: audioTrack)
                        + Self.mvex(tracks: [videoTrack, audioTrack]))
    return ftyp + moov
  }

  private static func mvex(tracks: [Track]) -> Data {
    var payload = Data()
    for track in tracks {
      var trex = Data()
      trex.append(uint32(track.id))
      trex.append(uint32(1))     // default_sample_description_index
      trex.append(uint32(0))     // default_sample_duration
      trex.append(uint32(0))     // default_sample_size
      trex.append(uint32(0))     // default_sample_flags
      // ★ trex 是 FullBox（ISO/IEC 14496-12 8.8.3）—— 少写 4 字节 version/flags，
      //   解析方就会把 track_id 读成 version+flags，整条轨道全错。
      payload.append(fullBox("trex", version: 0, flags: 0, payload: trex))
    }
    return box("mvex", payload)
  }

  private func videoTrak(size: (width: Int, height: Int), hvcC: Data, track: Track) -> Data {
    let tkhd = Self.fullBox("tkhd", version: 0, flags: 0x7,
                            payload: Self.tkhdPayload(trackId: track.id, width: size.width, height: size.height))
    let mdhd = Self.mdhdBox(timescale: track.timescale)
    let minf = Self.box("minf",
                        Self.fullBox("vmhd", version: 0, flags: 1,
                                     payload: Self.uint16(0) + Self.uint16(0) + Self.uint16(0) + Self.uint16(0))
                        + Self.dinfBox()
                        + Self.stblBox(sampleEntry: Self.hvc1Entry(width: size.width, height: size.height, hvcC: hvcC)))
    return Self.box("trak", tkhd + Self.box("mdia", mdhd + Self.handlerBox(kind: "vide", name: "VideoHandler") + minf))
  }

  private func audioTrak(asc: Data, track: Track) -> Data {
    let tkhd = Self.fullBox("tkhd", version: 0, flags: 0x7,
                            payload: Self.tkhdPayload(trackId: track.id, width: 0, height: 0))
    let mdhd = Self.mdhdBox(timescale: track.timescale)
    let minf = Self.box("minf",
                        Self.fullBox("smhd", version: 0, flags: 0, payload: Self.uint16(0) + Self.uint16(0))
                        + Self.dinfBox()
                        + Self.stblBox(sampleEntry: Self.mp4aEntry(sampleRate: audioSampleRate,
                                                                   channels: audioChannels, asc: asc)))
    return Self.box("trak", tkhd + Self.box("mdia", mdhd + Self.handlerBox(kind: "soun", name: "SoundHandler") + minf))
  }

  // MARK: - 分片（moof + mdat）

  private func buildFragment(video: [Sample], audio: [Sample], origin: Int64) throws -> Data {
    guard let videoTrack, let audioTrack else { throw RemuxError.malformed("轨道没建起来") }
    let videoSamples = Self.finalizedVideo(video, origin: origin)
    let audioSamples = Self.finalizedAudio(audio)

    let videoData = videoSamples.reduce(Data()) { $0 + $1.data }
    let audioData = audioSamples.reduce(Data()) { $0 + $1.data }

    func traf(track: Track, samples: [Sample], dataOffset: Int) -> Data {
      var tfhd = Data()
      tfhd.append(Self.uint32(track.id))
      let tfhdBox = Self.fullBox("tfhd", version: 0, flags: 0x020000, payload: tfhd)   // default-base-is-moof

      let tfdtBox = Self.fullBox("tfdt", version: 1, flags: 0,
                                 payload: Self.uint64(UInt64(max(0, samples.first?.dts ?? 0))))

      var trun = Data()
      trun.append(Self.uint32(UInt32(samples.count)))
      trun.append(Self.int32(Int32(dataOffset)))
      for sample in samples {
        trun.append(Self.uint32(UInt32(max(1, sample.duration))))
        trun.append(Self.uint32(UInt32(sample.data.count)))
        trun.append(Self.uint32(sample.isSync ? 0x02000000 : 0x01010000))
        trun.append(Self.int32(Int32(sample.cts)))
      }
      // flags: data-offset | sample-duration | sample-size | sample-flags | composition-offset
      let trunBox = Self.fullBox("trun", version: 1, flags: 0xF01, payload: trun)
      return Self.box("traf", tfhdBox + tfdtBox + trunBox)
    }

    func moofPayload() -> Data {
      let mfhd = Self.fullBox("mfhd", version: 0, flags: 0, payload: Self.uint32(sequence))
      var body = mfhd + traf(track: videoTrack, samples: videoSamples, dataOffset: 0)
      if !audioSamples.isEmpty {
        body += traf(track: audioTrack, samples: audioSamples, dataOffset: 0)
      }
      return body
    }

    // 先量一次算出 moof 大小（trun 里字段宽度不随值变化，量出来就是最终大小），
    // 再按真实偏移重造一遍 —— 比"写完回填"简单也不会漏
    let moofSize = moofPayload().count + 8
    let mfhd = Self.fullBox("mfhd", version: 0, flags: 0, payload: Self.uint32(sequence))
    var body = mfhd + traf(track: videoTrack, samples: videoSamples, dataOffset: moofSize + 8)
    if !audioSamples.isEmpty {
      body += traf(track: audioTrack, samples: audioSamples, dataOffset: moofSize + 8 + videoData.count)
    }
    guard body.count + 8 == moofSize else { throw RemuxError.malformed("moof 长度不稳定") }

    var mdat = Data()
    mdat.append(videoData)
    mdat.append(audioData)

    // 分片开头给个 styp（"media segment type"，Apple 的 fMP4 分片惯例）
    var stypPayload = Data("msdh".utf8)
    stypPayload.append(Self.uint32(0))
    for brand in ["msdh", "msix"] { stypPayload.append(Data(brand.utf8)) }
    // ★ 分片 = styp + moof + mdat。moof 这个盒子本身别漏（漏了的话解析方
    //   会把 mfhd/traf 当成顶层盒子，trun 的 data_offset 也就全错位）
    return Self.box("styp", stypPayload) + Self.box("moof", body) + Self.box("mdat", mdat)
  }

  /// 视频样本：时长按 DTS 间隔算，dts 平移到全流原点
  private static func finalizedVideo(_ samples: [Sample], origin: Int64) -> [Sample] {
    guard !samples.isEmpty else { return [] }
    var out = samples
    for i in 0..<(out.count - 1) {
      out[i].duration = max(1, out[i + 1].dts - out[i].dts)
    }
    // 最后一个样本的时长要等下一片才知道，先沿用上一个的
    out[out.count - 1].duration = out.count >= 2 ? out[out.count - 2].duration : 3000
    for i in out.indices { out[i].dts = max(0, out[i].dts - origin) }
    return out
  }

  /// 音频样本：时基已经是「相对全流原点的采样数」，时长固定 1024
  private static func finalizedAudio(_ samples: [Sample]) -> [Sample] {
    var out = samples
    for i in out.indices where out[i].duration <= 0 { out[i].duration = 1024 }
    return out
  }

  // MARK: - 盒子小工具

  private static func uint16(_ value: UInt16) -> Data { Data([UInt8(value >> 8), UInt8(value & 0xFF)]) }

  private static func uint32(_ value: UInt32) -> Data {
    Data([UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
  }

  private static func int32(_ value: Int32) -> Data { uint32(UInt32(bitPattern: value)) }

  private static func uint64(_ value: UInt64) -> Data {
    var data = Data()
    for shift in stride(from: 56, through: 0, by: -8) {
      data.append(UInt8((value >> UInt64(shift)) & 0xFF))
    }
    return data
  }

  private static func box(_ type: String, _ payload: Data) -> Data {
    uint32(UInt32(payload.count + 8)) + Data(type.utf8) + payload
  }

  private static func fullBox(_ type: String, version: UInt8, flags: UInt32, payload: Data) -> Data {
    var body = Data([version, UInt8((flags >> 16) & 0xFF), UInt8((flags >> 8) & 0xFF), UInt8(flags & 0xFF)])
    body.append(payload)
    return box(type, body)
  }

  private static let identityMatrix: [UInt32] = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

  private static func mvhd(nextTrackId: UInt32) -> Data {
    var payload = Data()
    payload.append(uint32(0))              // creation_time
    payload.append(uint32(0))              // modification_time
    payload.append(uint32(1000))           // timescale
    payload.append(uint32(0))              // duration
    payload.append(uint32(0x00010000))     // rate
    payload.append(uint16(0x0100))         // volume
    payload.append(uint16(0))              // reserved
    payload.append(uint32(0))
    payload.append(uint32(0))
    for value in identityMatrix { payload.append(uint32(value)) }
    for _ in 0..<6 { payload.append(uint32(0)) }
    payload.append(uint32(nextTrackId))
    return fullBox("mvhd", version: 0, flags: 0, payload: payload)
  }

  private static func tkhdPayload(trackId: UInt32, width: Int, height: Int) -> Data {
    var payload = Data()
    payload.append(uint32(0))              // creation_time
    payload.append(uint32(0))              // modification_time
    payload.append(uint32(trackId))
    payload.append(uint32(0))              // reserved
    payload.append(uint32(0))              // duration
    payload.append(uint32(0))
    payload.append(uint32(0))
    payload.append(uint16(0))              // layer
    payload.append(uint16(0))              // alternate_group
    payload.append(uint16(0))              // volume
    payload.append(uint16(0))              // reserved
    for value in identityMatrix { payload.append(uint32(value)) }
    payload.append(uint32(UInt32(width) << 16))
    payload.append(uint32(UInt32(height) << 16))
    return payload
  }

  private static func mdhdBox(timescale: UInt32) -> Data {
    var payload = Data()
    payload.append(uint32(0))              // creation_time
    payload.append(uint32(0))              // modification_time
    payload.append(uint32(timescale))
    payload.append(uint32(0))              // duration
    payload.append(uint16(0x55C4))         // language = 'und'
    payload.append(uint16(0))              // pre_defined
    return fullBox("mdhd", version: 0, flags: 0, payload: payload)
  }

  private static func handlerBox(kind: String, name: String) -> Data {
    var payload = Data()
    payload.append(uint32(0))              // pre_defined
    payload.append(Data(kind.utf8))
    payload.append(uint32(0))
    payload.append(uint32(0))
    payload.append(uint32(0))
    payload.append(Data(name.utf8))
    payload.append(0)
    return fullBox("hdlr", version: 0, flags: 0, payload: payload)
  }

  private static func dinfBox() -> Data {
    let url = fullBox("url ", version: 0, flags: 1, payload: Data())
    let dref = fullBox("dref", version: 0, flags: 0, payload: uint32(1) + url)
    return box("dinf", dref)
  }

  private static func stblBox(sampleEntry: Data) -> Data {
    let stsd = fullBox("stsd", version: 0, flags: 0, payload: uint32(1) + sampleEntry)
    let stts = fullBox("stts", version: 0, flags: 0, payload: uint32(0))
    let stsc = fullBox("stsc", version: 0, flags: 0, payload: uint32(0))
    let stsz = fullBox("stsz", version: 0, flags: 0, payload: uint32(0) + uint32(0))
    let stco = fullBox("stco", version: 0, flags: 0, payload: uint32(0))
    return box("stbl", stsd + stts + stsc + stsz + stco)
  }

  private static func hvc1Entry(width: Int, height: Int, hvcC: Data) -> Data {
    var payload = Data()
    payload.append(Data(repeating: 0, count: 6))   // reserved
    payload.append(uint16(1))                      // data_reference_index
    payload.append(uint16(0))                      // pre_defined
    payload.append(uint16(0))                      // reserved
    payload.append(uint32(0))                      // pre_defined[3]
    payload.append(uint32(0))
    payload.append(uint32(0))
    payload.append(uint16(UInt16(width)))
    payload.append(uint16(UInt16(height)))
    payload.append(uint32(0x00480000))             // horizresolution 72dpi
    payload.append(uint32(0x00480000))             // vertresolution
    payload.append(uint32(0))                      // reserved
    payload.append(uint16(1))                      // frame_count
    payload.append(Data(repeating: 0, count: 32))  // compressorname
    payload.append(uint16(0x0018))                 // depth
    payload.append(uint16(0xFFFF))                 // pre_defined = -1
    payload.append(hvcC)
    return box("hvc1", payload)
  }

  private static func mp4aEntry(sampleRate: Int, channels: Int, asc: Data) -> Data {
    var payload = Data()
    payload.append(Data(repeating: 0, count: 6))
    payload.append(uint16(1))                      // data_reference_index
    payload.append(uint32(0))
    payload.append(uint32(0))
    payload.append(uint16(UInt16(channels)))
    payload.append(uint16(16))                     // samplesize
    payload.append(uint16(0))                      // pre_defined
    payload.append(uint16(0))                      // reserved
    payload.append(uint32(UInt32(sampleRate) << 16))

    // esds: ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo(ASC) > SLConfig
    var dsi = Data([0x05, UInt8(asc.count)])
    dsi.append(asc)
    let sl = Data([0x06, 0x01, 0x02])
    var decoderConfig = Data([0x40, 0x15])         // MPEG-4 Audio / streamType 5
    decoderConfig.append(contentsOf: [0x00, 0x00, 0x00])   // bufferSizeDB
    decoderConfig.append(uint32(0))                // maxBitrate
    decoderConfig.append(uint32(0))                // avgBitrate
    decoderConfig.append(dsi)
    decoderConfig.append(sl)
    var dcd = Data([0x04, UInt8(decoderConfig.count)])
    dcd.append(decoderConfig)

    var es = Data()
    es.append(uint16(1))                           // ES_ID
    es.append(0)                                   // flags
    es.append(dcd)
    var esd = Data([0x03, UInt8(es.count)])
    esd.append(es)

    payload.append(fullBox("esds", version: 0, flags: 0, payload: esd))
    return box("mp4a", payload)
  }

  private static func buildHvcC(vps: [Data], sps: [Data], pps: [Data], params: VideoParams) -> Data {
    var payload = Data()
    payload.append(1)                              // configurationVersion
    payload.append(params.ptl)                     // 12 字节 PTL（profile_space … level_idc）
    payload.append(uint16(0xF000))                 // min_spatial_segmentation_idc
    payload.append(0xFC)                           // parallelismType = 0
    payload.append(UInt8(0xFC | (params.chromaFormat & 0x03)))
    payload.append(UInt8(0xF8 | ((params.bitDepthLuma - 8) & 0x07)))
    payload.append(UInt8(0xF8 | ((params.bitDepthChroma - 8) & 0x07)))
    payload.append(uint16(0))                      // avgFrameRate
    // constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) | lengthSizeMinusOne(2)
    let layers = UInt8(min(7, params.temporalLayers) & 0x07)
    let nested: UInt8 = params.temporalIdNested ? 0x04 : 0
    payload.append((layers << 3) | nested | 0x03)

    let arrays: [(UInt8, [Data])] = [(0x20, vps), (0x21, sps), (0x22, pps)]
    payload.append(UInt8(arrays.count))            // numOfArrays

    for (type, nals) in arrays {
      payload.append(type)
      payload.append(uint16(UInt16(nals.count)))
      for nal in nals {
        payload.append(uint16(UInt16(nal.count)))
        payload.append(nal)
      }
    }
    return box("hvcC", payload)
  }
}

/// 大端位读取器（HEVC SPS 用）。`skipping` 用来跳过 2 字节 NAL 头。
/// ★ 读之前会先剥掉防竞争字节（00 00 03 → 00 00），否则位对齐会错。
private struct BitReader {
  private let bytes: [UInt8]
  private var bitIndex: Int

  init(_ data: Data, skipping: Int) {
    var cleaned: [UInt8] = []
    let raw = [UInt8](data)
    var zeroCount = 0
    for byte in raw {
      if zeroCount >= 2 && byte == 0x03 {
        zeroCount = 0
        continue
      }
      cleaned.append(byte)
      zeroCount = byte == 0 ? zeroCount + 1 : 0
    }
    bytes = cleaned
    bitIndex = skipping * 8
  }

  private mutating func readBit() -> Bool? {
    guard bitIndex < bytes.count * 8 else { return nil }
    let byte = bytes[bitIndex >> 3]
    let shift = UInt8(7 - (bitIndex & 7))
    let bit = (byte >> shift) & 0x01
    bitIndex += 1
    return bit == 1
  }

  mutating func readFlag() throws -> Bool {
    guard let bit = readBit() else { throw TsFmp4Remuxer.RemuxError.malformed("SPS 读越界") }
    return bit
  }

  mutating func readBits(_ count: Int) throws -> UInt64 {
    var value: UInt64 = 0
    for _ in 0..<count {
      guard let bit = readBit() else { throw TsFmp4Remuxer.RemuxError.malformed("SPS 读越界") }
      value = (value << 1) | (bit ? 1 : 0)
    }
    return value
  }

  mutating func skipBits(_ count: Int) -> Bool {
    guard bitIndex + count <= bytes.count * 8 else { return false }
    bitIndex += count
    return true
  }

  mutating func readUE() throws -> UInt32 {
    var leadingZeros = 0
    while true {
      guard let bit = readBit() else { throw TsFmp4Remuxer.RemuxError.malformed("SPS 读越界") }
      if bit { break }
      leadingZeros += 1
      if leadingZeros > 31 { throw TsFmp4Remuxer.RemuxError.malformed("SPS exp-golomb 越界") }
    }
    guard leadingZeros > 0 else { return 0 }
    let rest = try readBits(leadingZeros)
    return UInt32(((1 << leadingZeros) - 1) + Int(rest))
  }
}
