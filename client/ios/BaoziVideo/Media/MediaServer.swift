import Foundation
import Network
import CryptoKit
import React

/**
 * 本地媒体服务（iOS 薄壳）。
 *
 * 与 Android 侧 `MediaServerModule.kt` 职责完全对称 —— 只做四件事，
 * **协议逻辑一律留在 TS**（见 `src/media/playlistRewriter.ts`）：
 *   1. 在回环地址上起一个 HTTP/1.1 服务
 *   2. 按会话注入请求头、透传 `Range` 去取上游
 *   3. 源1 主线路的 `wsSecret` **逐请求现算**（30 秒时效，没法预生成）
 *   4. 播放列表正文交给 JS 重写后再回给播放器
 *
 * ★ 为什么 iOS 也必须走这一层：AVPlayer **给不了自定义请求头**（公开 API 不支持，
 *   非公开键有审核风险，见文档 §6.2）。把取流收进本地服务，播放器就只需要
 *   认一个 `http://127.0.0.1:...` 的地址。
 *
 * 路由：`GET /m/<token>/<sid>/<b64url(原始地址)>/<文件名>`
 */
@objc(MediaServer)
final class MediaServer: RCTEventEmitter {

  private static let routePrefix = "m"
  private static let playlistEvent = "MediaServerPlaylist"
  private static let copyChunk = 64 * 1024
  private static let maxHeadBytes = 8192
  private static let rewriteTimeout: TimeInterval = 5
  /// 转封装探测先取多少字节 —— TS 的 PAT/PMT 就在最前面，64KB 绰绰有余
  private static let probeBytes = 64 * 1024

  /// 一次播放会话：注入哪些头、要不要逐请求签名、以及转封装状态。
  ///
  /// ★ 用 class 不用 struct —— 转封装状态（转封装器 / init 分片）是探测时
  ///   写进去、取分片时读出来的，值语义的话每次都得写回字典，容易漏。
  private final class Session {
    let headers: [String: String]
    let sign: [String: Any]?

    /// HEVC-TS -> fMP4 转封装器。非 nil 就是"这条线路走转封装"
    /// （只有 `prepareRemux` 探测成功才会建，见那里）
    var remuxer: TsFmp4Remuxer?
    /// `#EXT-X-MAP` 指向的初始化分片（moov）
    var remuxInit: Data?
    /// 探测时已经转好的那一片 —— 播放器再来要就直接给，别白转一次
    var probed: (target: String, data: Data)?
    /// 正在探测（挡住并发重复探测）
    var probing = false

    init(headers: [String: String], sign: [String: Any]?) {
      self.headers = headers
      self.sign = sign
    }
  }

  /// 一个挂起中的播放列表请求，等 JS 把重写结果交回来
  private final class Pending {
    let semaphore = DispatchSemaphore(value: 0)
    var body: String?
  }

  private var listener: NWListener?
  private var port: UInt16 = 0
  private var token = ""

  private let lock = NSLock()
  private var sessions: [String: Session] = [:]
  private var pending: [String: Pending] = [:]
  private var requestSeq = 0

  /// 探测用的取流会话（取播放列表正文 / 试转第一片）。
  ///
  /// ★ 与分片代理那条流分开：代理是边收边发（`UpstreamStream`），这里是整段拿。
  ///   `static let` —— Swift 保证只初始化一次，跨线程取用安全，不必再加锁。
  private static let probeSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    return URLSession(configuration: configuration)
  }()

  /// 播放列表地址（`.m3u8`）—— 转封装只作用于媒体分片，播放列表照旧走代理
  static func isPlaylistUrl(_ target: String) -> Bool {
    target.components(separatedBy: "?").first?.lowercased().hasSuffix(".m3u8") ?? false
  }

  // 这里**故意不声明** `requiresMainQueueSetup`：
  //   本模块不碰 UIKit，RN 按默认推断（无自定义 init、无 constants）得到 false，
  //   懒构造、任意线程，正是我们要的。
  //   （注意：真要声明的话得带 `override` —— RCTEventEmitter 同样 conform 了
  //     RCTBridgeModule，那个方法在协议里。）

  override func supportedEvents() -> [String]! { [MediaServer.playlistEvent] }

  // MARK: - 对 JS 暴露的接口

  @objc func start(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    if listener != nil {
      resolve(["port": Int(port), "token": token])
      return
    }

    let params = NWParameters.tcp
    // ★ 只绑回环 —— 不充当局域网内其他设备的通用代理（文档 §6.3 的安全边界）。
    //   将来做投屏再按需绑局域网网卡，届时只改这一处。
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
    params.allowLocalEndpointReuse = true

    let listener: NWListener
    do {
      listener = try NWListener(using: params)
    } catch {
      reject("media_server_start_failed", "本地媒体服务起不来：\(error)", error)
      return
    }

    let ready = DispatchSemaphore(value: 0)
    var startError: String?

    listener.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.port = listener.port?.rawValue ?? 0
        ready.signal()
      case .failed(let error):
        startError = "\(error)"
        ready.signal()
      default:
        break
      }
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection)
    }

    listener.start(queue: DispatchQueue.global(qos: .userInitiated))

    // 端口是内核分配的，得等监听器真的 ready 才知道
    if ready.wait(timeout: .now() + 5) == .timedOut || startError != nil {
      listener.cancel()
      reject("media_server_start_failed", startError ?? "本地媒体服务启动超时", nil)
      return
    }

    // ★ 拿不到端口就别硬撑 —— 明确失败，让 TS 侧走直连降级，
    //   否则会给出一个 http://127.0.0.1:0/... 的地址，播放时才发现是死路
    if port == 0 {
      listener.cancel()
      reject("media_server_start_failed", "本地媒体服务没拿到端口", nil)
      return
    }

    self.listener = listener
    self.token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    resolve(["port": Int(port), "token": token])
  }

  @objc func stop(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    listener?.cancel()
    listener = nil
    lock.lock()
    sessions.removeAll()
    let waiting = Array(pending.values)
    pending.removeAll()
    lock.unlock()
    // 唤醒所有等 JS 回话的请求，别让它们吊死在超时上
    for entry in waiting { entry.semaphore.signal() }
    resolve(nil)
  }

  @objc func createSession(_ sid: String,
                           configJson: String,
                           resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = configJson.data(using: .utf8),
          let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      reject("media_session_failed", "会话配置不是合法 JSON", nil)
      return
    }
    let headers = (config["headers"] as? [String: String]) ?? [:]
    let sign = config["sign"] as? [String: Any]
    lock.lock()
    sessions[sid] = Session(headers: headers, sign: sign)
    lock.unlock()
    resolve(nil)
  }

  /// 取一段文本（探测播放列表用）。
  ///
  /// 与分片代理同一套头注入 + 逐请求现算签名，但不重写、不透传 Range。
  ///
  /// ★ 绝不阻塞模块队列：RN 的方法都在同一条串行队列上，这里要去网络，
  ///   一阻塞就把 `respondPlaylist`（JS 回话）也卡住，5 秒重写超时就白等了。
  @objc func fetchText(_ sid: String,
                       url: String,
                       resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    let session = sessions[sid]
    lock.unlock()
    guard let session else {
      reject("media_session_missing", "会话不存在", nil)
      return
    }
    guard let request = request(for: url, session: session) else {
      reject("media_bad_target", "地址不合法", nil)
      return
    }
    let task = MediaServer.probeSession.dataTask(with: request) { data, response, error in
      guard error == nil,
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            let data,
            let text = String(data: data, encoding: .utf8) else {
        reject("media_fetch_text_failed", "取文本失败", error)
        return
      }
      resolve(text)
    }
    task.resume()
  }

  /// 探测并（成功时）开启转封装：拿第一片 TS 真转一次。
  ///
  /// 分两步走，为的是**不让绝大多数线路陪跑**：
  ///   1. 先只要前 64KB —— TS 的 PAT/PMT 就在最前面，足够判出视频是不是 HEVC。
  ///      不是（H.264 等）就到此为止，**不白下一整片**。
  ///   2. 是 HEVC 才整片取回来真转（转封装必须拿到完整一片：PES 要跨包重组、
  ///      片尾那个 NAL 要等下一片的起始码才知道结束）。
  ///
  /// ★ 为什么非得在这里先转第一片：转封装器的**时间轴原点**（tfdt 基准）是
  ///   全流第一片定下来的，而播放器取分片**不保证顺序**（会预取、会跳）。
  ///   先转一遍，原点就锚死在真正的第一片上，后面乱序来也不怕。
  ///
  /// 任何一步不成一律回 `{remux:false}`（照常直通）—— TS 里装 H.264 的线路本来
  /// 就不用转，"转得动就转"就是判定方式，不必另写一套编解码表。
  @objc func prepareRemux(_ sid: String,
                          segmentUrl: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    let lock = self.lock
    lock.lock()
    let session = sessions[sid]
    let busy = session?.probing ?? false
    let decided = session?.remuxer != nil
    if !busy && !decided { session?.probing = true }
    lock.unlock()

    guard let session, !busy else {
      // 会话不在 / 上一次探测还没回来：如实回当前状态，别让调用方干等
      resolve(["remux": decided])
      return
    }
    if decided {
      resolve(["remux": true])
      return
    }

    let finish: (Bool) -> Void = { ok in
      lock.lock()
      session.probing = false
      lock.unlock()
      resolve(["remux": ok])
    }
    let probeRange = "bytes=0-\(MediaServer.probeBytes - 1)"

    guard let request = request(for: segmentUrl, session: session, range: probeRange) else {
      finish(false)
      return
    }

    MediaServer.probeSession.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { finish(false); return }
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 0
      guard error == nil, (200..<300).contains(status), let data, !data.isEmpty else {
        finish(false)
        return
      }

      // ① 先嗅编解码 —— 不是 HEVC 就此收手
      guard TsFmp4Remuxer.videoStreamType(inTs: data) == 0x24 else {
        finish(false)
        return
      }

      // ② 是 HEVC。手上这坨可能本来就是完整一片（服务器不认 Range 回了整片，
      //    或者这片本身就比探测长度小），那就直接转；否则整片再来一次
      var complete = status == 200
      if let total = MediaServer.totalSize(of: http) { complete = data.count >= total }
      if complete, self.attemptRemux(session, data, segmentUrl, lock) {
        finish(true)
        return
      }
      self.fetchFullAndRemux(session: session, target: segmentUrl, lock: lock) { ok in
        finish(ok)
      }
    }.resume()
  }

  /// 整片取回来再转（探测第二步；只有判定是 HEVC 才走到这）
  private func fetchFullAndRemux(session: Session,
                                 target: String,
                                 lock: NSLock,
                                 finish: @escaping (Bool) -> Void) {
    guard let request = request(for: target, session: session) else {
      finish(false)
      return
    }
    MediaServer.probeSession.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { finish(false); return }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard error == nil, (200..<300).contains(status), let data else {
        finish(false)
        return
      }
      finish(self.attemptRemux(session, data, target, lock))
    }.resume()
  }

  /// 真转一次并把结果记到会话上。返回是否成功。
  ///
  /// ★ 转得动就转 —— HEVC + AAC 装在 TS 里才行，别的编码在这里抛异常，
  ///   那条线路照常直通。
  private func attemptRemux(_ session: Session,
                            _ data: Data,
                            _ target: String,
                            _ lock: NSLock) -> Bool {
    let remuxer = TsFmp4Remuxer()
    guard let fragment = try? remuxer.remux(segment: data),
          let initData = try? remuxer.initSegment() else { return false }
    lock.lock()
    session.remuxer = remuxer
    session.remuxInit = initData
    session.probed = (target, fragment)
    lock.unlock()
    return true
  }

  /// `Content-Range: bytes 0-65535/204732` 里的总长
  private static func totalSize(of response: HTTPURLResponse?) -> Int? {
    guard let value = response?.value(forHTTPHeaderField: "Content-Range") else { return nil }
    return value.split(separator: "/").last.flatMap { Int($0) }
  }

  @objc func closeSession(_ sid: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    sessions.removeValue(forKey: sid)
    lock.unlock()
    resolve(nil)
  }

  /// JS 把重写好的播放列表交回来，唤醒那个挂起的响应
  @objc func respondPlaylist(_ reqId: String,
                             text: String,
                             resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    let entry = pending[reqId]
    lock.unlock()
    entry?.body = text
    entry?.semaphore.signal()
    resolve(nil)
  }

  override func invalidate() {
    listener?.cancel()
    listener = nil
    super.invalidate()
  }

  // MARK: - HTTP 服务

  private func handle(_ connection: NWConnection) {
    connection.start(queue: DispatchQueue.global(qos: .userInitiated))
    readHead(connection, buffer: Data()) { [weak self] head in
      guard let self else { connection.cancel(); return }
      guard let head else {
        self.sendSimple(connection, status: 400, reason: "Bad Request")
        return
      }
      self.route(head, connection: connection)
    }
  }

  /// 读到 `\r\n\r\n` 为止。请求头很小，超过上限就放弃
  private func readHead(_ connection: NWConnection,
                        buffer: Data,
                        completion: @escaping (String?) -> Void) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, isComplete, error in
      var accumulated = buffer
      if let data { accumulated.append(data) }

      if accumulated.count > MediaServer.maxHeadBytes {
        completion(nil)
        return
      }
      if let range = accumulated.range(of: Data("\r\n\r\n".utf8)) {
        completion(String(data: accumulated[..<range.lowerBound], encoding: .utf8))
        return
      }
      if isComplete || error != nil {
        completion(nil)
        return
      }
      self.readHead(connection, buffer: accumulated, completion: completion)
    }
  }

  private func route(_ head: String, connection: NWConnection) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = (lines.first ?? "").components(separatedBy: " ")

    guard parts.count >= 2, parts[0] == "GET" else {
      sendSimple(connection, status: 405, reason: "Method Not Allowed")
      return
    }

    var range: String?
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      // 显式转成 String 再 trim —— Substring 上不一定有 trimmingCharacters
      let name = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
      if name.lowercased() == "range" {
        range = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      }
    }

    // 播放器偶尔会在地址后面挂 query（AVPlayer 就会）—— 先切掉再解析路径
    let path = parts[1].components(separatedBy: "?").first ?? parts[1]
    let segments = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      .components(separatedBy: "/")

    guard segments.count >= 4, segments[0] == MediaServer.routePrefix else {
      sendSimple(connection, status: 404, reason: "Not Found")
      return
    }
    guard segments[1] == token else {
      sendSimple(connection, status: 403, reason: "Forbidden")
      return
    }

    lock.lock()
    let session = sessions[segments[2]]
    lock.unlock()

    guard let session else {
      sendSimple(connection, status: 404, reason: "No Session")
      return
    }

    // 转封装会话的初始化分片（`#EXT-X-MAP` 指向它）：`/m/<token>/<sid>/init.mp4`
    if segments.count == 4, segments[3] == "init.mp4" {
      guard let initData = session.remuxInit else {
        sendSimple(connection, status: 404, reason: "No Init Segment")
        return
      }
      sendBytes(connection, data: initData, contentType: "video/mp4", range: range)
      return
    }

    guard segments.count >= 5,
          let target = MediaServer.decodeBase64Url(segments[3]),
          target.hasPrefix("http") else {
      sendSimple(connection, status: 400, reason: "Bad Target")
      return
    }

    // 转封装会话的**媒体分片**：整段取回、转成 fMP4 再给（播放列表不走这里）
    if session.remuxer != nil, !MediaServer.isPlaylistUrl(target) {
      remux(target: target, session: session, range: range, connection: connection)
      return
    }

    proxy(sid: segments[2], target: target, session: session, range: range, connection: connection)
  }

  /// 转封装会话取分片：整段取回 -> TS 转 fMP4 -> 发给播放器。
  ///
  /// ★ 不能像普通分片那样边收边发：转封装必须拿到**完整一片**
  ///   （PES 要跨包重组、片尾那个 NAL 要等下一片的起始码才知道结束）。
  ///   代价是内存峰值 = 一片的大小（几百 KB ～ 1 MB 级），可以接受。
  private func remux(target: String,
                     session: Session,
                     range: String?,
                     connection: NWConnection) {
    guard let remuxer = session.remuxer,
          let request = request(for: target, session: session) else {
      sendSimple(connection, status: 502, reason: "Bad Gateway")
      return
    }

    // 探测时已经转好的那一片直接给（顺带省掉一次网络往返）
    lock.lock()
    let probed = session.probed
    lock.unlock()
    if let probed, probed.target == target {
      sendBytes(connection, data: probed.data, contentType: "video/mp4", range: range)
      return
    }

    MediaServer.probeSession.dataTask(with: request) { data, response, error in
      guard error == nil,
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            let data else {
        self.sendSimple(connection, status: 502, reason: "Bad Gateway")
        return
      }
      // ★ 播放器会预取，两片可能同时在转 —— 转封装器不是线程安全的
      //   （分片序号、init 缓存都是有状态的），这里串起来
      self.lock.lock()
      let fragment = try? remuxer.remux(segment: data)
      self.lock.unlock()

      guard let fragment else {
        self.sendSimple(connection, status: 502, reason: "Remux Failed")
        return
      }
      self.sendBytes(connection, data: fragment, contentType: "video/mp4", range: range)
    }.resume()
  }

  /// 造一个上游请求：注入会话头 + 逐请求现算签名。`nil` = 地址不合法
  private func request(for target: String, session: Session, range: String? = nil) -> URLRequest? {
    // ★ 每次请求都现算签名 —— wsSecret 只有 30 秒时效
    let finalUrl = session.sign.flatMap { MediaServer.signUrl(target, sign: $0) } ?? target
    guard let url = URL(string: finalUrl) else { return nil }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 30
    for (name, value) in session.headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    if let range { request.setValue(range, forHTTPHeaderField: "Range") }
    return request
  }

  private func proxy(sid: String,
                     target: String,
                     session: Session,
                     range: String?,
                     connection: NWConnection) {
    guard var request = request(for: target, session: session) else {
      sendSimple(connection, status: 502, reason: "Bad Upstream")
      return
    }
    let isPlaylistUrl = MediaServer.isPlaylistUrl(target)

    // ★ 播放列表**绝不能带 Range** —— 带了上游回 206 + 半截正文，
    //   重写出来就是个残缺的播放列表。按原地址的后缀先判一次。
    if let range, !range.isEmpty, !isPlaylistUrl {
      request.setValue(range, forHTTPHeaderField: "Range")
    }

    // URLSession 会强引用 delegate 直到 session 失效，所以 stream 不会被提前回收
    let stream = UpstreamStream(connection: connection,
                                isPlaylistUrl: isPlaylistUrl,
                                rewrite: { [weak self] url, text in
                                  self?.askJsToRewrite(sid: sid, url: url, text: text) ?? text
                                })
    stream.start(request: request)
  }

  /// 把播放列表正文交给 JS 重写。
  ///
  /// ★ 超时或 JS 报错一律**原样透传** —— 最坏结果是播放列表没被改写
  ///   （源2 会被限速），但绝不能让播放器卡在"正在解析线路"上。
  private func askJsToRewrite(sid: String, url: String, text: String) -> String {
    lock.lock()
    requestSeq += 1
    let reqId = "r\(requestSeq)"
    let entry = Pending()
    pending[reqId] = entry
    lock.unlock()

    sendEvent(withName: MediaServer.playlistEvent, body: [
      "reqId": reqId,
      "sid": sid,
      "url": url,
      "text": text,
    ])

    let waited = entry.semaphore.wait(timeout: .now() + MediaServer.rewriteTimeout)

    lock.lock()
    pending.removeValue(forKey: reqId)
    lock.unlock()

    guard waited == .success, let body = entry.body else { return text }
    return body
  }

  // MARK: - 签名

  /// 现算 `wsSecret` 并拼进 query。
  ///
  /// 与 `参考/影视站api1.js` 的 `wsSecret()` / `signQuery()` 等价：
  ///   `wsSecret = MD5(key + pathname + hex(ts))` 小写
  /// `extra`（`ck` 解出来的 `k=..&Time=..&uid=..`）拼进 query 但**不参与** md5，
  /// 少了它源站回 463（签名对但访问凭证缺）。
  ///
  /// 具体模板由 TS 下发（`src/media/segmentSigner.ts`），这里只是个字符串机器。
  static func signUrl(_ raw: String, sign: [String: Any]) -> String? {
    // ★ 必须是 var —— 下面要改写 percentEncodedQuery
    guard var parsed = URLComponents(string: raw) else { return nil }
    let path = parsed.percentEncodedPath
    let seconds = Int(Date().timeIntervalSince1970)
    let tsHex = String(UInt32(truncatingIfNeeded: seconds), radix: 16)

    var input = (sign["template"] as? String) ?? "{key}{path}{tsHex}"
    input = input.replacingOccurrences(of: "{key}", with: (sign["key"] as? String) ?? "")
    input = input.replacingOccurrences(of: "{path}", with: path)
    input = input.replacingOccurrences(of: "{tsHex}", with: tsHex)
    input = input.replacingOccurrences(of: "{ts}", with: String(seconds))

    let secret = Insecure.MD5.hash(data: Data(input.utf8))
      .map { String(format: "%02x", $0) }
      .joined()

    let drop = Set((sign["drop"] as? [String]) ?? [])
    var kept: [String] = []
    if let query = parsed.percentEncodedQuery {
      for pair in query.components(separatedBy: "&") where !pair.isEmpty {
        let name = pair.components(separatedBy: "=").first ?? pair
        if !drop.contains(name) { kept.append(pair) }
      }
    }
    let extra = (sign["extra"] as? String) ?? ""
    if !extra.isEmpty { kept.append(extra) }
    kept.append("\((sign["param"] as? String) ?? "wsSecret")=\(secret)")
    kept.append("\((sign["tsParam"] as? String) ?? "wsTime")=\(tsHex)")

    parsed.percentEncodedQuery = kept.joined(separator: "&")
    return parsed.url?.absoluteString
  }

  // MARK: - 工具

  static func decodeBase64Url(_ text: String) -> String? {
    var base64 = text.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64 += "=" }
    guard let data = Data(base64Encoded: base64) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func sendSimple(_ connection: NWConnection, status: Int, reason: String) {
    let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
      connection.cancel()
    })
  }

  /// 把一个**已经在内存里**的响应发出去（init 分片 / 转封装后的分片）。
  ///
  /// 支持 `Range`：播放器偶尔会先探一小段（`bytes=0-1`）判断容器，
  /// 回一个 200 通常也能过，但既然整段都在手里，正确回 206 更稳妥。
  private func sendBytes(_ connection: NWConnection,
                         data: Data,
                         contentType: String,
                         range: String?) {
    var status = "200 OK"
    var body = data
    var extra = ""
    if let range, let bounds = MediaServer.parseRange(range, total: data.count) {
      body = data.subdata(in: bounds)
      status = "206 Partial Content"
      extra = "Content-Range: bytes \(bounds.lowerBound)-\(bounds.upperBound - 1)/\(data.count)\r\n"
    }

    var head = "HTTP/1.1 \(status)\r\n"
    head += "Content-Type: \(contentType)\r\n"
    head += "Accept-Ranges: bytes\r\n"
    head += "Content-Length: \(body.count)\r\n"
    head += extra
    head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
    connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
      connection.send(content: body, isComplete: true, completion: .contentProcessed { _ in
        connection.cancel()
      })
    })
  }

  /// 解析 `Range: bytes=start-end` / `bytes=start-` / `bytes=-N`。
  /// 多段（逗号分隔）不支持 —— 播放器不会这么要，真来了就当整段回。
  static func parseRange(_ header: String, total: Int) -> Range<Int>? {
    guard total > 0 else { return nil }
    let value = header.lowercased().replacingOccurrences(of: "bytes=", with: "")
    let parts = value.components(separatedBy: "-")
    guard parts.count == 2, !value.contains(",") else { return nil }

    if parts[0].isEmpty {
      guard let length = Int(parts[1]), length > 0 else { return nil }
      return max(0, total - length)..<total
    }
    guard let start = Int(parts[0]), start < total else { return nil }
    let end = parts[1].isEmpty ? total - 1 : min(total - 1, Int(parts[1]) ?? total - 1)
    guard end >= start else { return nil }
    return start..<(end + 1)
  }
}

/**
 * 一次上游取流：把响应头与正文按流送进客户端连接。
 *
 * ★ 不整体缓冲 —— mp4 的 Range 请求可能是 `bytes=0-`（整文件），
 *   全读进内存会直接吃掉几百 MB。
 */
private final class UpstreamStream: NSObject, URLSessionDataDelegate {

  private let connection: NWConnection
  private let isPlaylistUrl: Bool
  private let rewrite: (String, String) -> String

  private var session: URLSession?
  /// 上游响应状态码。**0 = 还没拿到响应**（连不上 / 超时 / DNS 挂了 / 被 ATS 拦）
  ///
  /// ★ 用它把"上游明确回了错"和"压根没连上"分开。URLSession 的失败走
  ///   `didCompleteWithError` 回调、不抛异常，非成功路径上 `status` 会停在
  ///   声明时的初值 —— 初值若是 200，失败就被**伪装成空 200** 回给播放器
  ///   （见 `didCompleteWithError` / `finishPlaylist`）。
  private var status = 0
  private var headers: [String: String] = [:]
  private var playlistBuffer = Data()
  private var treatAsPlaylist = false
  private var finished = false

  init(connection: NWConnection,
       isPlaylistUrl: Bool,
       rewrite: @escaping (String, String) -> String) {
    self.connection = connection
    self.isPlaylistUrl = isPlaylistUrl
    self.rewrite = rewrite
  }

  func start(request: URLRequest) {
    // 每个取流自带一个 session —— delegate 由 session 强引用，直到它被失效
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    session.dataTask(with: request).resume()
  }

  private func finish() {
    connection.cancel()
    session?.invalidateAndCancel()
    session = nil
  }

  func urlSession(_ session: URLSession,
                  dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    if let http = response as? HTTPURLResponse {
      status = http.statusCode
      for (key, value) in http.allHeaderFields {
        headers[String(describing: key).lowercased()] = String(describing: value)
      }
    } else {
      // 进得来 didReceive 说明连接是通的，给个 200 —— 别让 status 停在
      // 0 那个"没拿到响应"的哨兵值上（正常不会走到这里）
      status = 200
    }
    let type = headers["content-type"]?.lowercased() ?? ""
    treatAsPlaylist = isPlaylistUrl || type.contains("mpegurl")

    if treatAsPlaylist {
      // 播放列表要整体拿到才能重写，先攒着
      completionHandler(.allow)
      return
    }

    sendHead()
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if treatAsPlaylist {
      playlistBuffer.append(data)
      return
    }
    connection.send(content: data, completion: .contentProcessed { _ in })
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard !finished else { return }
    finished = true

    if treatAsPlaylist {
      // 播放列表是整体拿全才重写的，正文没有边发边送 —— 响应头还在手里，
      // 这里可以自由决定回什么状态码
      finishPlaylist(task: task, error: error)
      return
    }

    // ★ 分片 / mp4：一个响应头都还没发出去就失败了
    //   （连不上 / 超时 / DNS 挂了 / 被 ATS 拦），直接给 502。
    //   绝不能回 200 —— 播放器收到"空 200"不当错误，它会一直等，
    //   表现就是黑屏且什么都不提示，排查时两眼一抹黑。
    if status == 0 {
      sendFailure(502, reason: "Bad Gateway")
      return
    }

    // 正文已经边收边发了，这里发一个 FIN 收尾。
    // ★ 这种"头已发出、正文半截"的断流改不了状态码，只能靠上游给的
    //   `Content-Length` 让播放器自己发现短了。要彻底解决得先整体缓冲，
    //   但 mp4 的 Range 可能是整文件，缓冲会吃掉几百 MB —— 不值当。
    connection.send(content: Data(), isComplete: true, completion: .contentProcessed { _ in
      self.finish()
    })
  }

  /**
   * 播放列表收尾 —— 只有"整段拿到 + 上游 2xx + 能解码"才回 200 并重写。
   *
   * ★ 其余一律当失败。原来的写法在这条路上有个洞：URLSession 的失败走回调、
   *   不抛异常，`status` 会停在初值上，于是"压根没连上"被回成一个
   *   `HTTP/1.1 200` + `Content-Length: 0` 的**空成功响应** ——
   *   播放器不报错，只是黑屏。跟 Android 侧（`conn.connect()` 抛异常、
   *   直接断连）行为不一致，也是这次 iOS 黑屏难排查的原因之一。
   */
  private func finishPlaylist(task: URLSessionTask, error: Error?) {
    if error == nil, status >= 200, status < 300,
       let text = String(data: playlistBuffer, encoding: .utf8) {
      let rewritten = rewrite(task.originalRequest?.url?.absoluteString ?? "", text)
      let body = Data(rewritten.utf8)
      var head = "HTTP/1.1 200 OK\r\n"
      head += "Content-Type: application/vnd.apple.mpegurl\r\n"
      head += "Content-Length: \(body.count)\r\n"
      head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
      connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
        self.connection.send(content: body, completion: .contentProcessed { _ in
          self.finish()
        })
      })
      return
    }

    // 只有"上游明确拒绝"才值得把它的状态码原样透传 —— 判据是响应收到了
    // （status 非 0）、整段也读完了（error 为 nil）、且确实是非 2xx。
    // 半截正文、解不出 UTF-8、连不上都归 502。
    let upstreamRefused = (error == nil) && status >= 400
    sendFailure(upstreamRefused ? status : 502,
                reason: upstreamRefused ? "" : "Bad Gateway")
  }

  /// 上游没给出可用内容时的兜底响应。`reason` 传空串就只回状态码
  private func sendFailure(_ code: Int, reason: String) {
    var head = "HTTP/1.1 \(code) \(reason)\r\n"
    head += "Content-Type: text/plain; charset=utf-8\r\n"
    head += "Content-Length: 0\r\n"
    head += "Connection: close\r\n\r\n"
    connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
      self.finish()
    })
  }

  private func sendHead() {
    var head = "HTTP/1.1 \(status) \r\n"
    head += "Content-Type: \(headers["content-type"] ?? "application/octet-stream")\r\n"
    head += "Accept-Ranges: bytes\r\n"
    head += "Cache-Control: no-store\r\n"
    if let length = headers["content-length"] { head += "Content-Length: \(length)\r\n" }
    if let contentRange = headers["content-range"] { head += "Content-Range: \(contentRange)\r\n" }
    head += "Connection: close\r\n\r\n"
    connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
  }
}
