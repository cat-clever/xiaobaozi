/**
 * 源 2（韩圈精选特色源）的协议常量。
 *
 * 全部取自 `参考/影视站api2.js`，**改上游之前不要动这里**。
 */

export const BASE = 'https://hxqapi.hiyun.tv';

/** 设备身份伪装 */
export const VC = 'a_8350';
export const VN = '6.9';
export const CH = 'xiaomi';
export const APP = 'hj';
export const UA = 'HanjuTV/6.9 (MI 6X; Android 9; Scale/2.00)';

/** 播放 UA。实测 CDN **不校验** UA，所以这条是"可省"的 */
export const PLAY_UA = 'tdc.8350';

/**
 * 两张 material 表。
 *
 * 响应解密用 DEC，**查询参数**签名用 SIGN —— 两张表用途完全不同，别搞混。
 * 来源：libdecjni.so 的 .rodata（base 表 @0x12d90 + 索引表 @0x12dd0）。
 */
export const MATERIAL_DEC = '34F9Q53w/HJW8E6Q';
export const MATERIAL_SIGN = '2E159Q/Z8979WckQ';

/** `uk` 头的硬编码密钥 —— 与设备号派生**无关**，是独立的一条路 */
export const UK_KEY = 'f349wghhe784tqwh';
export const UK_IV = 'd3w8hf94fidk38lk';

/** 神策埋点匿名 ID。服务端不校验 */
export const SAID = 'd0645e7ce2315ef9';

/** 兜底设备号（没带 uid 时用） */
export const DEFAULT_DEVICE_UID = 'nvzATwGTRTY8qN6geDtH';

/** 设备号只认 20 位 [0-9A-Za-z] */
export const UID_RE = /^[0-9A-Za-z]{20}$/;

/**
 * CDN 节点的备用设备号池。
 *
 * 上游**按设备号把 CDN 节点钉死**：同一个号换多少 IP 都分到同一个节点；
 * 分到哪个是首次请求时随机定的，之后固定。下面是逐个实测过 3/3 稳定拿到 https 的号。
 */
export const GOOD_UIDS = [
  'nvzATwGTRTY8qN6geDtH', 'jciRRolL4MVuzAWRvUTE', 'Z7LJEEBD5zp6UYta1jSA',
  'nsjG1DUjZJxzZ1Wj2PfS', 'kpwwM0iQuvAQZaLMvNUm', 'fyHxRb8eAe9H77YQJnSv',
  'j5O0R3JcyRd0vUbNZ3ZD', 'sIST78IpWolBSLgX50Wg', 'bDKVgtDVxuX66RiPPJv7',
  'klXOqqDuhcW9t2B485LF', 'rSlaNMvRtF3nh0KPMQDV', 'pnBDyN12ZBxehPg3VSxF',
  'eAIvVHVHSd4X779NljfC', 'qwxxPx7uczjR9CPJQ35J', 'nR2xHuq68wYFJqIvCiaY',
  'pk4oks6BodUuqC66j8b3', 'kEesuRvrTUcgpPF5b0Ay', 'jiE7gkxUdgRnfS6Gkd1G',
  'sGGAQAvety6QNLWfADWj', 'siLGwnZzm8LcmMfs5s2E', 'gMOuLtc1ktr782QiHVhg',
  'nJ5G1qWL3CKzX4MH24bw', 's4AFjr3hCmrCIwq5Ue1D', 'dhY2B72MGuReItOhL89p',
  'Zsje1bvDixseravibsx7', 'rF9gMg53eTI9Kp5Mvpho', 'Yx6cV8bN3mQ7wE5rT1up',
  'Zx9cV2bN5mQ8wE3rT7uy',
];

/**
 * 换号重试最多试几个。
 *
 * 号本身都是好号，但对**源自己在抖**的剧多试才有意义：
 * 按 44% 单次成功率算，6 次尝试（首次 + 换号 5）覆盖率约 97%，4 次只有约 90%。
 */
export const GOOD_UID_TRIES = 5;

/** 101（看广告解锁）的场景名 */
export const SCENE_REWARD = 'ad_series_play';

/** 明星作品集的分类 */
export const WORKS_CATE: Record<number, string> = { 1: '影视', 3: '综艺' };

/** 随机 20 位设备号用的字符集 */
export const RAND_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
