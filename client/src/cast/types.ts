/**
 * 投屏的公共类型。
 *
 * 设计见文档 §5.5：**投屏的本质是把播放地址交给接收端，由接收端自己取流**。
 * 所以这里的一切都围绕"怎么把一枚地址递出去"展开，而不是"我们怎么推流"。
 */

/** 投屏协议。DLNA 双端都做；AirPlay 只有 iOS 有（系统能力） */
export type CastProtocol = 'dlna' | 'airplay';

/** 发现到的一台可投设备 */
export interface CastDevice {
  /**
   * 稳定 id。
   *
   * ★ 优先用 UPnP 的 `UDN`（设备描述里的 `udn:` 那串），拿不到就退回
   *   `location` 的主机部分 —— **不能因为缺 UDN 就把设备丢掉**（宽松校验）。
   */
  id: string;
  /** 展示名。描述里读不到就退回主机地址 */
  name: string;
  protocol: CastProtocol;
  /** 厂商 / 型号，能读到就显示，读不到留空 */
  model?: string;
  /** 设备地址（展示用） */
  address?: string;
  /**
   * DLNA：`AVTransport` 服务的控制地址（已经解析成绝对地址）。
   * AirPlay 设备没有这个字段。
   */
  controlUrl?: string;
  /**
   * DLNA：该设备 `AVTransport` 的 `serviceType`（含版本号，如
   * `urn:schemas-upnp-org:service:AVTransport:1`）。
   * ★ SOAP 的 `SOAPACTION` 头必须跟它**逐字一致** —— 版本号写错有的电视直接拒。
   */
  serviceType?: string;
}

/** 一条 SSDP 原始响应（原生交上来的） */
export interface SsdpHit {
  location: string;
  usn: string;
  st: string;
  server: string;
  address: string;
}

/** 投屏播放状态（遥控器用） */
export interface CastTransportState {
  /** 归一化后的状态；设备给不出就 `unknown` */
  state: 'playing' | 'paused' | 'stopped' | 'transitioning' | 'unknown';
  /** 当前进度（秒）；拿不到就是 null */
  positionSec: number | null;
  /** 总时长（秒）；拿不到就是 null */
  durationSec: number | null;
}

/** 一次投屏会话 */
export interface CastSession {
  device: CastDevice;
  /**
   * `true` = **直投**：地址是裸直链，电视自己去 CDN 取流，
   * 手机可以息屏、可以退出 App。
   * `false` = **转发兜底**：流经手机的本地媒体服务，手机必须活着。
   */
  direct: boolean;
  /** 交给电视的地址 */
  url: string;
  /** 这条线路的名字（UI 上显示"正在投屏 · 线路名"） */
  lineName: string;
  /** 结束投屏；转发模式要顺带把本地会话关掉 */
  stop: () => Promise<void>;
}
