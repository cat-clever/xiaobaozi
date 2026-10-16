/** 跨源统一数据模型（DTO）—— 把两个上游的差异抹平 */

export type SourceId = 's1' | 's2';

/** 统一影视条目 */
export interface VodItem {
  id: string;
  sourceId: SourceId;
  title: string;
  coverUrl: string;
  rating: string;
  category: string;
  year: string;
  area: string;
  remarks: string;
  intro: string;
}

/** 统一分集 */
export interface Episode {
  /** 在选集数组里的下标（0 起）—— UI 用它定位，**不要**拿它当上游的 collection_id */
  episodeIndex: number;
  /**
   * 上游的选集 id（源1 的 `vod_collection[].id`）。
   *
   * ★ 这个才是 `collection_v2` 要的 `collection_id`。
   *   之前只有 episodeIndex，等于把数组下标当 id 传给了上游。
   */
  episodeId?: string;
  title: string;
  /** 源1：只有发它的那个账号能用 */
  vodToken?: string;
  curTime?: string;
  duration: string;
  durationSec: number;
  /** 源2 用 */
  pid?: string;
  scid?: string;
}

/** 线路类型，与上游 CommonM3U8JsonEntry.type 对齐 */
export type LineKind = 'signed' | 'mirror' | 'official' | 'm3u8' | 'backup';

/** 统一线路实体。端内解析后**直接持有真实地址**，不再需要 token 传递 */
export interface PlayLine {
  type: number;
  kind: LineKind;
  name: string;
  /** 真实播放地址 */
  url: string;
  /** kind === 'official' 时：第三方解析前缀 */
  parsePrefix?: string;
  /** kind === 'signed' 时：签名要拼的访问凭证 */
  ck?: string;
  /**
   * kind === 'signed' 时：该马甲的 CDN 密钥。
   *
   * ★ 每个马甲一把，**不能混用** —— 播放时用的账号和这里的密钥必须来自同一个马甲，
   *   否则源站回 403。本地媒体服务靠它现算 wsSecret。
   */
  wsKey?: string;
  playable: boolean;
  /** 不可播原因，供 UI 直接展示 */
  note: string;
}

/** 交给播放器的最终地址 */
export interface ResolvedMediaStream {
  /**
   * 播放地址。
   *
   * 正常是**本地媒体服务**的地址（`http://127.0.0.1:<port>/m/...`）；
   * 原生服务不可用时退回上游直连地址（源2 会被限速、源1 主线路会 403）。
   */
  streamUrl: string;
  format: 'hls' | 'mp4';
  /**
   * 播放器需要注入的请求头。
   *
   * 走本地服务时是**空的** —— 请求头由服务注入（文档 §6.2）；
   * 只有退回直连时才有值。
   */
  headers: Record<string, string>;
  lineName: string;
  /** 播放结束/离开页面时调用，关掉这个播放会话 */
  dispose?: () => Promise<void>;
}

/** 统一详情 */
export interface VodDetail {
  vodId: string;
  sourceId: SourceId;
  name: string;
  pic: string;
  actor: string;
  director: string;
  year: string;
  area: string;
  blurb: string;
  episodes: Episode[];
  /**
   * 源2 用：**清晰度档位**。
   *
   * ★ 别跟 `playFor()` 返回的 `items` 搞混 —— 那个是**同一集的多个分段**
   *   （一集可能被切成十几段 mp4），不是清晰度。清晰度走 `sq` 参数重新解析。
   */
  qualities?: Array<{ label: string; value: number }>;
  /**
   * 源2 用：**季列表**。只有多季的剧才会有内容（上游给 `buckets`）。
   *
   * ★ 上游把**每一季当成一部独立的剧**（独立的 `sid`）：
   *   切季 = 拿那一季的 sid 重新拉一次详情，`vodId` / `episodes`
   *   也跟着变成那一季的。所以这里存 sid，而不是"第几季"的下标。
   *
   *   （2026-10-16 用户实测反馈：以前没往上传，多季的剧点进去
   *   只能看到当前那一季，「顶楼3」就只显示第三季的 14 集。）
   */
  seasons?: Array<{ sid: string; title: string }>;
}
