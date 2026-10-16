/**
 * 源 1（全网综合影视源）的协议常量。
 *
 * 全部取自 `参考/影视站api1.js`，**改上游之前不要动这里**。
 * 密钥与盐值以参考实现为准，客户端与之逐字节对齐。
 */

/** 马甲编号 —— 决定以哪个 App 的身份调接口，不同身份行为差异很大 */
export const MAHAO = {
  /** 叠影视频 ★ 默认：游客不限额，无需老账号 */
  DIEYING: 0,
  /** 天际视频：游客只有第 1 次播放给真实路径，必须配 DEVICE_ID / TOKEN */
  TIANJI: 1,
  /** 彩虹视频（新接口）：游客不限额 */
  CHSP: 2,
  /** 彩虹视频（老接口）：同一个 App 的另一代路径，游客也不限额 */
  CHSP_OLD: 3,
} as const;

export type MahaoId = (typeof MAHAO)[keyof typeof MAHAO];

/** 接口代次：同一后端两代路径，参数与返回结构一致，仅路径不同 */
export type ApiStyle = 'new' | 'old';

export interface MahaoEntry {
  label: string;
  appId: string;
  packageName: string;
  version: string;
  channelCode: string;
  /**
   * 该马甲的网宿 CDN 密钥 —— **每个马甲一把，不可混用**。
   * wsSecret = MD5(ws_key + path + wsTime_hex)，密钥不对源站回 403。
   */
  wsKey: string;
  /** 留空 = 用接口下发的 sec_domain；指定则覆盖 */
  secDomain: string;
  lineMode: number;
  api: ApiStyle;
}

export const MAHAO_TABLE: Record<MahaoId, MahaoEntry> = {
  [MAHAO.DIEYING]: {
    label: '叠影视频',
    appId: 'dieyingshipin',
    packageName: 'com.pathrecall.gj',
    version: '50000',
    channelCode: 'dysp_sp01',
    wsKey: '6Jh7hrLCXBrutmJEYpMpvbU3LDEHwUZY',
    secDomain: '',
    lineMode: 0,
    api: 'new',
  },
  [MAHAO.TIANJI]: {
    label: '天际视频',
    appId: 'xingkongshipin',
    packageName: 'com.lineone.connecter',
    version: '50100',
    channelCode: 'xk_sp01',
    wsKey: 'vT1RQRz8YzlzTgN26pIXNJ7Mi65juwSP',
    secDomain: '',
    lineMode: 0,
    api: 'new',
  },
  // 2 与 3 是同一个 App（彩虹视频）、**同一把密钥**，只是接口代次不同
  [MAHAO.CHSP]: {
    label: '彩虹视频（新接口）',
    appId: 'caihongshipin',
    packageName: 'com.hjmore.hdcre',
    version: '43000',
    channelCode: 'sp01',
    wsKey: 'af2tu1aCoXwDIUpAFBv7i8sDhpi3cSrr',
    secDomain: '',
    lineMode: 0,
    api: 'new',
  },
  [MAHAO.CHSP_OLD]: {
    label: '彩虹视频（老接口）',
    appId: 'caihongshipin',
    packageName: 'com.hjmore.hdcre',
    version: '43000',
    channelCode: 'sp01',
    wsKey: 'af2tu1aCoXwDIUpAFBv7i8sDhpi3cSrr',
    secDomain: '',
    lineMode: 0,
    api: 'old',
  },
};

/** 默认马甲 */
export const DEFAULT_MAHAO: MahaoId = MAHAO.DIEYING;

/** 自动降级链：挑第一个能用的，运行中挂了自动往下换 */
export const AUTO_CHAIN: MahaoId[] = [
  MAHAO.DIEYING,
  MAHAO.CHSP,
  MAHAO.CHSP_OLD,
  MAHAO.TIANJI,
];

/** 天际马甲的常驻老账号凭据（只有天际吃老账号，其余一律当新游客） */
export const TIANJI_DEVICE_ID = '96ab557f6826febf';
export const TIANJI_TOKEN =
  'gAAAAABqyeanWUJ6JutPAslzwyrJdqtIZthjnfZrAfgFmbZhOdDlJYtI4XCW3TfbAFIRrDoecPmA32TWPizIq5tewpE0QHRYpGZCUPGL0HV14wFuwQo-4qf8ON1pMBiFF3Odq7p2oyw7K5szpSE-nwiGUYU5_5zA5bb6p8Q_23gYcanLA1XXLJp1RX8Iz645_e_aaRibg25KSTyJKOErmhgiiAJ-nlp6TA==';

/**
 * 首选域名。
 *
 * ★ 实测（2026-10-15，国内网络，逐个域名单独跑 init）：
 *
 *     u.gslock.com     161 ms   ← 就用它
 *     u.yyxdmn.com     440 ms
 *     u.jsyysm.com     792 ms
 *     u.skzsz.com     1015 ms
 *     u.uccao.cn      7718 ms   ← 引导域名，国内 DNS 被污染成 1.1.1.1
 *
 *   原实现把 `u.uccao.cn`（参考实现里的引导域名）排第一 ——
 *   那个排序是给**境外 Cloudflare Worker** 用的，在国内每冷启动一次
 *   就白等 7.7 秒。客户端跑在国内，直接按实测速度排。
 *   （README 里写的源1 上游本来就是 u.gslock.com。）
 */
export const DEFAULT_BASE = 'https://u.gslock.com';

/** 兜底域名池：首选域名不通时按顺序往下试 */
export const FALLBACK_BASES = [
  'https://u.yyxdmn.com',
  'https://u.jsyysm.com',
  'https://u.skzsz.com',
  'https://u.uccao.cn',
];

/** 请求签名盐值（对应 App 的 C4006.m14334()） */
export const SIGN_SALT = 'zD9[bM4~sF4~uY2)';
/** 响应解密的 AES 密钥与 IV（对应 C2481.f4267 / f4268）。32 字节 = AES-256 */
export const AES_KEY = 'aZ9$kU5%qI7=yC2=zH2#gM0@pX7^wF3a';
export const AES_IV = 'hY2&tN3]kF7,dL7=';

export const SYS_PLATFORM = '2';

/** 接口成功码 */
export const SUCCESS_CODE = 10000;
export const API_TIMEOUT_MS = 12000;

/**
 * 媒体分片的 UA。
 *
 * ★ 源站 CDN 对 UA 做了**白名单**，不是它一律 403 ——
 *   这就是为什么拿 okhttp 的 UA 去取永远是 403，而 App 能播。
 */
export const MEDIA_UA = 'Mozi';

/**
 * 图片站基址。
 *
 * ★ 实测（2026-10-15）：`recommend_v2` / `screen_v2` 回的 `vod_pic` 是**绝对地址**，
 *   但 `collection_list_v2` 回的是**相对路径**（`upload/vod/...`）。
 *   详情页恰好走的就是 collection_list，于是封面一直是空白。
 *   `sys_conf` 里没有下发图片域名，只能取实测到的这台。
 */
export const IMAGE_BASE = 'http://wim.xzjykj.com/';

/** 封面图的 UA：图片站与视频源不是一回事，别套 Mozi */
export const IMAGE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 接口请求的 UA（模拟 App 自身的网络栈） */
export const API_UA = 'okhttp/4.9.0';

/** 签名线路必须带的自定义头 */
export const BADCI = '723baba511fd6e9378e4f9eec2a97ca3';

/** sec_domain 兜底：真正能取到片的镜像站 */
export const SEC_DOMAIN_FALLBACK = 'http://chw.ycblhs.com';

/**
 * 占位路径的主机名。
 *
 * 接口对没有配额的账号一律下发同一条固定占位路径（所有剧共用）。
 * 只看 is_p2p 会误报，必须结合主机名判断。
 */
export const PLACEHOLDER_HOST = 'ydsp.skzsz.com';

/** 上游对突发请求敏感：重试次数别多、间隔要长 */
export const RETRIES = 2;
export const RETRY_SLEEP_MS: [number, number] = [3000, 6000];

/** 内容缓存 TTL */
export const CACHE_TTL_MS = 300 * 1000;

/** 取流时遇到这些状态码重试（覆盖第三方 m3u8 源偶发的不稳） */
export const RETRY_STATUS = new Set([403, 404, 429, 500, 502, 503]);

/** 线路类型，与 App 的 CommonM3U8JsonEntry.type 对齐 */
export const LINE_MIRROR = 4;
export const LINE_OFFICIAL = 1;
export const LINE_M3U8 = 2;
export const LINE_BACKUP = 3;
export const LINE_SIGNED = 5;

/** 接口路径表（新老两代） */
export const API_PATHS: Record<ApiStyle, Record<string, string>> = {
  new: {
    init: '/api/new_public/init_v2',
    types: '/api/new_type/list_v2',
    screen: '/api/new_search/screen_v2',
    search: '/api/new_search/result_v2',
    recommend: '/api/new_search/recommend_v2',
    detail: '/api/new_video/result_v2',
    collection: '/api/new_video/collection_v2',
    collection_list: '/api/new_video/collection_list_v2',
    channels: '/api/new_channel/get_list_v2',
    hot_search: '/api/new_search/hot_search_v2',
    suggest: '/api/new_search/suggest_v2',
    user_info: '/api/new_user/info_v2',
    history: '/api/new_user_history/get_list_v2',
    history_remove_all: '/api/new_user_history/remove_all_v2',
  },
  old: {
    init: '/api/public/init',
    types: '/api/type/get_list',
    screen: '/api/search/screen',
    search: '/api/search/result',
    recommend: '/api/search/recommend',
    detail: '/api/video/result',
    collection: '/api/video/collection',
    collection_list: '/api/video/collection_list',
    channels: '/api/channel/get_list',
    hot_search: '/api/search/hot_search',
    suggest: '/api/search/suggest',
    user_info: '/api/user/info',
    history: '/api/user_history/get_list',
    history_remove_all: '/api/user_history/remove_all',
  },
};

/** 一条能直接播的线路都没有时的提示 */
export const NO_USABLE_LINE_HINT =
  '这些线路当前都播不了：主线路需要接口下发真实路径（占位路径在源站上不存在），' +
  '备用线路上也没有对应文件。';

/** 自动降级链全挂时的提示 */
export const ALL_DOWN_HINT = '所有接口都不可用';
