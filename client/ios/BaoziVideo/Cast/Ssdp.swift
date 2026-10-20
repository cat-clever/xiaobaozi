import Darwin
import Foundation
import React

/**
 * SSDP 组播发现（iOS）。
 *
 * ★★ 跟 Android 那份**行为完全对齐**（见 `cast/SsdpModule.kt`）：原生只发
 *   M-SEARCH、收响应、把 `LOCATION` 那一行交回 JS。设备描述怎么解析、
 *   `AVTransport` 怎么找、SOAP 怎么发，**全在 TS**（`src/cast/dlna.ts`）。
 *
 * ★★ **校验一律从宽**（用户 2026-10-16 的硬要求）：
 *   · 不按 `ST` / `USN` / `Server` 过滤 —— 只要回包**有 `LOCATION` 就收**
 *   · 三个 `ST`（MediaRenderer / AVTransport / `ssdp:all`）各发一包，重复四轮
 *   · 两个 socket 一起收：临时端口那个收**单播**响应（规范要求），
 *     绑 1900 并 `IP_ADD_MEMBERSHIP` 那个收**组播**响应（不合规但真实存在）
 *
 * ★★ **iOS 14 起要「本地网络」权限**：没有 `NSLocalNetworkUsageDescription`
 *   的话系统会**静默拒绝**组播与局域网访问 —— 表现为"什么都发现不了"，
 *   而且不报错。见 `Info.plist`。
 */
@objc(Ssdp)
final class Ssdp: NSObject {

  /// ★ 必须 false：发现是纯 IO，跑在后台队列上，不该占主线程
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /**
   * 发现局域网里的设备。**永不 reject** —— 收不到就回空数组，
   * 让 UI 去说"未发现设备"，而不是抛一个用户看不懂的错。
   */
  @objc(discover:resolver:rejecter:)
  func discover(
    _ timeoutMs: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      resolve(SsdpDiscovery.run(timeoutMs: timeoutMs.doubleValue))
    }
  }
}

private let kSsdpGroup = "239.255.255.250"
private let kSsdpPort: UInt16 = 1900
/// 收包阻塞超时 —— 把"等几秒"切成小段，好按时发下一轮 M-SEARCH
private let kRecvTimeoutMs = 350
private let kRounds = 4

/// `ssdp:all` 故意留着：TS 那边靠"描述里有没有 AVTransport"筛，比在这儿按 ST 猜准
private let kTargets = [
  "urn:schemas-upnp-org:device:MediaRenderer:1",
  "urn:schemas-upnp-org:service:AVTransport:1",
  "ssdp:all",
]

enum SsdpDiscovery {

  static func run(timeoutMs: Double) -> [[String: String]] {
    var found: [String: [String: String]] = [:]

    let unicast = makeUnicastSocket()
    let group = makeGroupSocket()
    defer {
      if unicast >= 0 { close(unicast) }
      if group >= 0 { close(group) }
    }

    let deadline = Date().addingTimeInterval(max(0.8, timeoutMs / 1000.0))
    var round = 0
    var buffer = [UInt8](repeating: 0, count: 4096)

    while Date() < deadline {
      if round < kRounds {
        sendSearch(fd: unicast)
        sendSearch(fd: group)
        // ★★ 单播兜底：iOS 14+ 发组播要 multicast 权限，侧载包拿不到 ——
        //   组播那条路会静默失败（sendto 返回 -1，没人看返回值）。
        //   单播只受"本地网络"权限约束，所以直接把 M-SEARCH 打到网段里
        //   每一台的 1900 端口。第 0 / 2 轮各扫一次，给慢设备留时间。
        if round == 0 || round == 2 { sweepUnicast(fd: unicast) }
        round += 1
      }
      drain(fd: unicast, buffer: &buffer, into: &found)
      drain(fd: group, buffer: &buffer, into: &found)
    }
    return Array(found.values)
  }

  // MARK: - socket

  /// 临时端口，收**单播**响应 —— 绝大多数设备走这条
  private static func makeUnicastSocket() -> Int32 {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    guard fd >= 0 else { return -1 }
    setReuse(fd)
    setRecvTimeout(fd)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = INADDR_ANY
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard ok == 0 else {
      close(fd)
      return -1
    }
    // 组播 TTL 给 2（跨一层交换机足够）；出口接口交给系统按路由挑
    var ttl: UInt8 = 2
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, socklen_t(MemoryLayout<UInt8>.size))
    return fd
  }

  /// 绑 1900 并加入组播组，收**组播**响应 —— 不合规但真实存在的设备走这条。
  /// 绑不上（端口被别的 App 占了）就返回 -1，不影响单播那条。
  private static func makeGroupSocket() -> Int32 {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    guard fd >= 0 else { return -1 }
    setReuse(fd)
    setRecvTimeout(fd)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = kSsdpPort.bigEndian
    addr.sin_addr.s_addr = INADDR_ANY
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard ok == 0 else {
      close(fd)
      return -1
    }
    var req = ip_mreq()
    req.imr_multiaddr.s_addr = inet_addr(kSsdpGroup)
    req.imr_interface.s_addr = INADDR_ANY
    let joined = setsockopt(
      fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &req, socklen_t(MemoryLayout<ip_mreq>.size)
    )
    guard joined == 0 else {
      close(fd)
      return -1
    }
    return fd
  }

  /**
   * 把 M-SEARCH 打到本机所在网段的每一台设备（**单播**）。
   *
   * ★ 为什么要这条：iOS 14 起，往组播地址收发要
   *   `com.apple.developer.networking.multicast` 权限。侧载 / 未签名包
   *   拿不到（要 Apple 单独批），组播 `sendto` 直接失败 —— 而原来的代码
   *   忽略了返回值，所以表现是"一个设备都搜不到"。单播走的是普通 UDP，
   *   只要用户给了"本地网络"权限就行。
   *
   * ★ 只扫本机所在的 /24（最多 254 台），不扫 /16 —— 够用且不会刷屏。
   *   另外补一包子网广播（有些设备只认广播）。
   */
  private static func sweepUnicast(fd: Int32) {
    guard fd >= 0, let lan = lanIPv4() else { return }
    let base = lan.ip & 0xFFFF_FF00
    guard base != 0 else { return }
    for host in UInt32(1)...UInt32(254) {
      let target = base | host
      if target == lan.ip { continue }
      sendSearch(fd: fd, to: target)
    }
    let broadcast = (lan.ip & lan.mask) | ~lan.mask
    if broadcast != 0 && broadcast != lan.ip {
      sendSearch(fd: fd, to: broadcast)
    }
  }

  /** 本机 Wi-Fi / 以太网的 IPv4 地址与掩码（host 序）。 */
  private static func lanIPv4() -> (ip: UInt32, mask: UInt32)? {
    var addrs: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&addrs) == 0, let first = addrs else { return nil }
    defer { freeifaddrs(addrs) }

    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ptr = cursor {
      let ifa = ptr.pointee
      let name = String(cString: ifa.ifa_name)
      if name == "en0" || name == "en1" {
        if let sa = ifa.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) {
          let rawIP = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            $0.pointee.sin_addr.s_addr
          }
          let rawMask = ifa.ifa_netmask?.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            $0.pointee.sin_addr.s_addr
          } ?? 0
          let ip = UInt32(bigEndian: rawIP)
          let mask = UInt32(bigEndian: rawMask)
          if ip != 0 && mask != 0 { return (ip, mask) }
        }
      }
      cursor = ifa.ifa_next
    }
    return nil
  }

  private static func setReuse(_ fd: Int32) {
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, socklen_t(MemoryLayout<Int32>.size))
  }

  private static func setRecvTimeout(_ fd: Int32) {
    var tv = timeval(tv_sec: 0, tv_usec: Int32(kRecvTimeoutMs * 1000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  }

  // MARK: - 收发

  /// `to` 传 host 序的 IPv4；不传就打组播组（原来的行为）。
  private static func sendSearch(fd: Int32, to: UInt32? = nil) {
    guard fd >= 0 else { return }
    var dest = sockaddr_in()
    dest.sin_family = sa_family_t(AF_INET)
    dest.sin_port = kSsdpPort.bigEndian
    dest.sin_addr.s_addr = to.map { $0.bigEndian } ?? inet_addr(kSsdpGroup)
    for target in kTargets {
      let text = "M-SEARCH * HTTP/1.1\r\n"
        + "HOST: \(kSsdpGroup):\(kSsdpPort)\r\n"
        + "MAN: \"ssdp:discover\"\r\n"
        + "MX: 2\r\n"
        + "ST: \(target)\r\n\r\n"
      let bytes = Array(text.utf8)
      _ = withUnsafePointer(to: &dest) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          sendto(fd, bytes, bytes.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
  }

  private static func drain(
    fd: Int32,
    buffer: inout [UInt8],
    into found: inout [String: [String: String]]
  ) {
    guard fd >= 0 else { return }
    while true {
      var from = sockaddr_in()
      var fromLen = socklen_t(MemoryLayout<sockaddr_in>.size)
      let n = withUnsafeMutablePointer(to: &from) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          recvfrom(fd, &buffer, buffer.count, 0, $0, &fromLen)
        }
      }
      // 超时（-1）或对端关闭（0）都结束这一轮
      if n <= 0 { return }
      let data = Data(bytes: buffer, count: n)
      guard let text = String(data: data, encoding: .isoLatin1) else { continue }
      if let hit = parse(text, address: host(from)) {
        found[hit["location"]!] = hit
      }
    }
  }

  private static func host(_ addr: sockaddr_in) -> String {
    var raw = addr.sin_addr
    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    guard inet_ntop(AF_INET, &raw, &buf, socklen_t(INET_ADDRSTRLEN)) != nil else { return "" }
    return String(cString: buf)
  }

  // MARK: - 解析

  /**
   * ★★ **只看 `LOCATION`** —— 没有它这条回包对我们毫无用处，有它就收。
   *   `USN` / `ST` / `SERVER` 拿不到就给空串，**不因为缺字段丢掉设备**。
   * ★ 头名**大小写不敏感**，有的设备还带前后空格 —— 一并处理。
   */
  private static func parse(_ text: String, address: String) -> [String: String]? {
    guard text.lowercased().hasPrefix("http/1.") else { return nil }
    var location = ""
    var usn = ""
    var st = ""
    var server = ""
    for raw in text.components(separatedBy: "\r\n") {
      guard let idx = raw.firstIndex(of: ":") else { continue }
      let name = raw[raw.startIndex..<idx].trimmingCharacters(in: .whitespaces).lowercased()
      let value = raw[raw.index(after: idx)...].trimmingCharacters(in: .whitespaces)
      switch name {
      case "location": if location.isEmpty { location = value }
      case "usn": usn = value
      case "st": st = value
      case "server": server = value
      default: break
      }
    }
    guard !location.isEmpty else { return nil }
    return [
      "location": location,
      "usn": usn,
      "st": st,
      "server": server,
      "address": address,
    ]
  }
}
