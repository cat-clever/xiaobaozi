/**
 * 本地媒体服务的原生模块访问口。
 *
 * 原生侧只做四件事：起 socket、取上游、逐请求现算签名、透传 Range。
 * **协议逻辑一律留在 TS**（见 `playlistRewriter.ts` / `segmentSigner.ts`）。
 */
import { NativeEventEmitter, NativeModules } from 'react-native';
import type { EmitterSubscription } from 'react-native';

export interface MediaServerStartResult {
  port: number;
  token: string;
  /**
   * 本机的**局域网**地址（IPv4）。拿不到就是空串。
   *
   * ★ 投屏必须用它 —— 电视取不到手机的 `127.0.0.1`（文档 §6.3）。
   *   本地播放**不用**它（照旧走回环），所以拿不到也不影响任何现有功能。
   */
  lanHost: string;
}

/** 原生下发给 JS 的播放列表重写请求 */
export interface PlaylistRequestEvent {
  reqId: string;
  sid: string;
  /** 播放列表的**原始**地址（重写时要用它做基准与 query 来源） */
  url: string;
  /** 上游原样的播放列表正文 */
  text: string;
}

/** 转封装探测结果。`remux: false` = 这条线路照常直通（普通 TS / mp4） */
export interface RemuxVerdict {
  remux: boolean;
}

export interface MediaServerNativeModule {
  start(): Promise<MediaServerStartResult>;
  stop(): Promise<void>;
  /** configJson 见 `mediaServer.ts` 的 MediaNativeConfig */
  createSession(sid: string, configJson: string): Promise<void>;
  closeSession(sid: string): Promise<void>;
  /** 把重写后的播放列表交回原生，原生据此完成那个挂起的 HTTP 响应 */
  respondPlaylist(reqId: string, text: string): Promise<void>;
  /**
   * 取一段文本（走同一套头注入 + 逐请求现算签名），结果直接回给 JS。
   * 探测播放列表要用 —— 探测得先知道第一条分片的地址。**Android 侧没有**
   * （转封装是 iOS 专属，见 `prepareRemux`），所以声明成可选、调用前先判。
   */
  fetchText?(sid: string, url: string): Promise<string>;
  /**
   * 探测并（成功时）开启 HEVC-TS -> fMP4 转封装。
   *
   * ★ 为什么非转不可：AVFoundation 的 MPEG-TS 解封装**不认 HEVC**，
   *   AVPlayer 会静默丢掉视频轨（只剩声音、画面全黑）；Apple 的 HLS 规范也
   *   写死了 HEVC 的容器必须是 fMP4。Android 的 ExoPlayer 自己能解，不需要。
   *
   * 原生会先取这条分片试转一次，成功就把会话标成转封装模式（顺带锚定
   * 时间轴原点），失败就照常直通。**Android 侧没有这个方法。**
   */
  prepareRemux?(sid: string, segmentUrl: string): Promise<RemuxVerdict>;
}

const native = (NativeModules as Record<string, unknown>).MediaServer as
  | MediaServerNativeModule
  | undefined;

/** 原生模块是否装上了。没装上时上层退回直连（会限速 / 403，但不会整个播不了） */
export const isMediaServerAvailable = (): boolean => !!native;

export const MediaServerNative = native;

/** 事件通道。原生模块不存在时为 null */
export const mediaServerEvents: NativeEventEmitter | null = native
  ? new NativeEventEmitter(native as never)
  : null;

export const PLAYLIST_EVENT = 'MediaServerPlaylist';

export function onPlaylistRequest(
  handler: (event: PlaylistRequestEvent) => void,
): EmitterSubscription | null {
  // RN 的 EmitterSubscription 监听签名是 (...args: Object[])，这里收窄成具体事件
  const listener = handler as unknown as (...args: unknown[]) => void;
  return mediaServerEvents?.addListener(PLAYLIST_EVENT, listener) ?? null;
}
