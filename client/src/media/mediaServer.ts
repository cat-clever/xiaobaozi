/**
 * 本地媒体服务（文档 §6.3「统一媒体出口」）。
 *
 * 设备内跑一个轻量 HTTP 服务，作为**本地播放与投屏的统一媒体出口**：
 *   1. 请求头注入（源1 分片要 `Mozi`，签名线路另需 `Badci`），透传 `Range`
 *   2. 播放列表重写（源2 必需，否则 CDN 限速到几乎不下发）
 *   3. 源1 主线路的 `wsSecret` **逐分片现算**（30 秒时效，不可能预生成）
 *
 * 播放器因此只认一个本地地址，**不再需要任何自定义头能力** ——
 * 这正是文档 §6.2 想要的效果（iOS 的 AVPlayer 本来也给不了自定义头）。
 *
 * 生命周期：进播放页起、离开播放页关（文档 §6.3 的安全边界）。
 * 本轮只绑回环地址；投屏要用局域网地址，届时只改 `ensureServer()` 一处。
 */
import { base64UrlEncode } from '../utils/base64';
import { utf8 } from '../utils/bytes';
import {
  MediaServerNative,
  isMediaServerAvailable,
  onPlaylistRequest,
} from './NativeMediaServer';
import type { PlaylistRequestEvent } from './NativeMediaServer';
import { firstMediaSegment, rewritePlaylist } from './playlistRewriter';
import type { SignRule } from './segmentSigner';

/** 交给原生的会话配置（播放列表重写规则留在 TS，不下发） */
export interface MediaNativeConfig {
  headers: Record<string, string>;
  sign: SignRule | null;
}

export interface MediaSessionConfig extends MediaNativeConfig {
  /** 播放列表重写规则；`null` = 不是播放列表（mp4 直通，不做重写） */
  playlist: { inheritQuery: boolean } | null;
}

interface ServerInfo {
  port: number;
  token: string;
  /** 本机局域网地址；空串 = 没有局域网（投屏用不了，本地播放不受影响） */
  lanHost: string;
}

let serverPromise: Promise<ServerInfo> | null = null;
/** 服务起来之后缓存的局域网地址 —— `currentLanHost()` 要能同步问它 */
let lanHostCache = '';
let unsubscribe: (() => void) | null = null;
let sequence = 0;

const sessions = new Map<string, MediaSession>();

/** 取播放地址里最后一段当文件名 —— 播放器靠后缀选对管线（.m3u8 / .mp4 / .ts） */
function basenameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.slice(path.lastIndexOf('/') + 1);
    if (last && last.includes('.')) return last;
    return `${last || 'index'}.ts`;
  } catch {
    return 'seg.ts';
  }
}

export class MediaSession {
  /**
   * 是否走 HEVC-TS -> fMP4 转封装（`prepareRemux()` 探测出来后置位）。
   *
   * ★ 置位后有两处不同：分片地址报成 `.m4s`（内容已是 fMP4），
   *   播放列表里补 `#EXT-X-MAP` 指向 init 分片。
   */
  private remuxing = false;

  /** 这条线路会不会转封装（播放列表重写据此决定写不写 `#EXT-X-MAP`） */
  get usesRemux(): boolean {
    return this.remuxing;
  }

  constructor(
    readonly id: string,
    /** 本地地址前缀：`http://127.0.0.1:<port>/m/<token>/<sid>` */
    private readonly base: string,
    readonly config: MediaSessionConfig,
  ) {}

  /** 播放器靠后缀选管线 —— 转封装会话里分片已经不是 TS 了，报 `.m4s` */
  private localNameOf(upstreamUrl: string): string {
    const name = basenameOf(upstreamUrl);
    // 只改媒体分片；`.key` / `.m3u8` 之类原样保留
    return this.remuxing ? name.replace(/\.ts$/i, '.m4s') : name;
  }

  /** 上游地址 -> 本地代理地址 */
  toLocal(upstreamUrl: string): string {
    return `${this.base}/${base64UrlEncode(utf8(upstreamUrl))}/${this.localNameOf(upstreamUrl)}`;
  }

  /** 顶层播放地址。文件名由调用方定，好让播放器按后缀选管线 */
  streamUrl(upstreamUrl: string, format: 'hls' | 'mp4'): string {
    const name = format === 'hls' ? 'index.m3u8' : 'video.mp4';
    return `${this.base}/${base64UrlEncode(utf8(upstreamUrl))}/${name}`;
  }

  /** `#EXT-X-MAP` 指向的初始化分片（原生按会话提供，不带上游地址） */
  initUrl(): string {
    return `${this.base}/init.mp4`;
  }

  /**
   * 探测这条线路要不要转封装 —— 必须在**播放器开始取流之前**调。
   *
   * ★ 为什么不能等播放器自己报错再补救：`#EXT-X-MAP` 得写在播放列表里，
   *   而播放列表是播放器第一件事就去取的。等它取回来再决定已经晚了。
   *
   * 步骤（协议规则全在这里，原生只当字符串机器 / 网络代理）：
   *   1. 原生取回播放列表正文（头注入 + 现算签名都归它）
   *   2. 用 `firstMediaSegment` 算出第一条分片的绝对地址
   *   3. 让原生拿这一条试转一次；成不成由它回话
   *
   * 任何一步出问题都当"不转"—— 最坏退回原来的表现（HEVC-TS 线路黑屏），
   * 不会比不探测更糟。
   */
  async prepareRemux(playlistUrl: string): Promise<boolean> {
    if (!this.config.playlist || this.remuxing) return this.remuxing;
    const native = MediaServerNative;
    if (!native?.fetchText || !native.prepareRemux) return false;
    try {
      const text = await native.fetchText(this.id, playlistUrl);
      // 加密线路别碰：分片是密文，转封装只会转出一堆垃圾
      if (!text || /#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text)) return false;

      const first = firstMediaSegment(text, playlistUrl, this.config.playlist.inheritQuery);
      if (!first) return false;

      const verdict = await native.prepareRemux(this.id, first);
      this.remuxing = verdict?.remux === true;
    } catch {
      this.remuxing = false;
    }
    return this.remuxing;
  }

  async close(): Promise<void> {
    sessions.delete(this.id);
    try {
      await MediaServerNative?.closeSession(this.id);
    } catch {
      // 关不掉就算了，服务本身也会随进程结束
    }
  }
}

/** 起服务（幂等）。失败会抛，由上层决定退回直连 */
async function ensureServer(): Promise<ServerInfo> {
  if (!MediaServerNative) throw new Error('本地媒体服务未接入（原生模块缺失）');
  if (!serverPromise) {
    serverPromise = MediaServerNative.start().catch((err: unknown) => {
      serverPromise = null; // 起失败就清掉，让下次重试
      throw err;
    });
    if (!unsubscribe) {
      const sub = onPlaylistRequest(handlePlaylistRequest);
      unsubscribe = sub ? () => sub.remove() : null;
    }
    // 把局域网地址顺手记下来，投屏那边要同步问（`currentLanHost`）
    serverPromise = serverPromise.then((info) => {
      lanHostCache = info.lanHost || '';
      return info;
    });
  }
  return serverPromise;
}

/**
 * 原生把播放列表正文交上来，这里重写完再交回去。
 *
 * ★ 任何异常都**原样透传** —— 重写失败最多是播放列表没被改写（源2 会限速），
 *   但不能因为重写报错让整个播放卡死在"正在解析线路"。
 */
function handlePlaylistRequest(event: PlaylistRequestEvent): void {
  let output = event.text;
  const session = sessions.get(event.sid);
  if (session?.config.playlist) {
    try {
      output = rewritePlaylist(event.text, event.url, {
        inheritQuery: session.config.playlist.inheritQuery,
        toLocal: (url) => session.toLocal(url),
        // 转封装会话要补 `#EXT-X-MAP`；普通会话不传，播放列表结构一点不动
        mapUri: session.usesRemux ? session.initUrl() : null,
      });
    } catch {
      output = event.text;
    }
  }
  void MediaServerNative?.respondPlaylist(event.reqId, output);
}

/**
 * 开一个播放会话。调用方负责在离开播放页时 `close()`。
 *
 * `preferLan` 只在**投屏**时为 true（见 `cast/source.ts`）：
 *   - `false`（默认，本地播放）：地址用**回环** —— 行为跟投屏功能加进来之前
 *     **一模一样**，一点没动
 *   - `true`（投屏）：地址用**局域网** —— 接收端取不到手机的 `127.0.0.1`
 *
 * ★ 拿不到局域网地址时，投屏这条也会老实退回回环；调用方要自己判一次
 *   "这个地址电视取不取得到"（`cast/source.ts` 会看 `currentLanHost()`）。
 */
export async function openSession(
  config: MediaSessionConfig,
  preferLan = false,
): Promise<MediaSession> {
  const { port, token, lanHost } = await ensureServer();
  const id = `s${(sequence += 1)}`;
  const host = preferLan && lanHost ? lanHost : '127.0.0.1';
  const session = new MediaSession(id, `http://${host}:${port}/m/${token}/${id}`, config);

  // ★ 先登记再通知原生 —— 万一播放列表请求在原生回话前就进来，
  //   `handlePlaylistRequest` 得能查到会话
  sessions.set(id, session);

  const payload: MediaNativeConfig = { headers: config.headers, sign: config.sign };
  try {
    await MediaServerNative?.createSession(id, JSON.stringify(payload));
  } catch (err) {
    // 原生没登记成功就退回直连，别留一个查不到的会话
    sessions.delete(id);
    throw err;
  }

  return session;
}

/** 播放页离开时收摊 */
export async function shutdownMediaServer(): Promise<void> {
  for (const session of Array.from(sessions.values())) {
    await session.close();
  }
  sessions.clear();
  unsubscribe?.();
  unsubscribe = null;
  try {
    await MediaServerNative?.stop();
  } catch {
    // 忽略
  }
  serverPromise = null;
  lanHostCache = '';
}

/**
 * 本机当前的局域网地址（投屏要用）。空串 = 没局域网 / 服务没起来。
 * ★ 纯查询，不触发起服务。
 */
export function currentLanHost(): string {
  return lanHostCache;
}

export { isMediaServerAvailable };
