/**
 * 源 1 的线路解析。
 *
 * 与 `参考/影视站api1.js` 的 playLines() 一一对应。
 *
 * 注意分工：**本层只组装线路表，不取流**。
 * 真正的取流（现算 wsSecret、注入 Badci、重写 m3u8）由本地媒体服务承担，
 * 因为 wsSecret 只有 30 秒时效，必须在每次分片请求时现算。
 */
import {
  LINE_BACKUP,
  LINE_M3U8,
  LINE_MIRROR,
  LINE_OFFICIAL,
  LINE_SIGNED,
  PLACEHOLDER_HOST,
  SEC_DOMAIN_FALLBACK,
} from './constants';
import { parseCk } from './crypto';
import { episodeTitle } from '../../utils/episode';
import type { Episode, PlayLine } from '../../types/schema';

/** 把 `vod_url` 的域名换成 sec_domain 镜像站，**保留原 pathname** */
export function mirrorUrl(vodUrl: string, secDomain: string): string {
  if (!vodUrl || !secDomain) return '';
  try {
    const parts = new URL(vodUrl);
    let root = new URL(secDomain);

    // 接口下发的 sec_domain 可能变成采集站自己的域名（与 vod_url 同域）——
    // 那这个"换域名"等于没换，线路还是指向那台一律 403 的源站。
    // 同域就说明镜像没生效，退回已知可用的镜像域名。
    if (root.host === parts.host) {
      root = new URL(SEC_DOMAIN_FALLBACK);
      if (root.host === parts.host) return '';
    }
    return new URL(parts.pathname + parts.search, root.origin).toString();
  } catch {
    return '';
  }
}

/**
 * 这条 vod_url 是不是那条**所有剧公用**的占位路径。
 *
 * ★ 只看 is_p2p 会误报，必须结合主机名判断。
 *   占位地址直连只会拿到一段 11 秒的警告片。
 */
export function isPlaceholderUrl(vodUrl: string): boolean {
  if (!vodUrl) return false;
  try {
    return new URL(vodUrl).host.toLowerCase() === PLACEHOLDER_HOST;
  } catch {
    return false;
  }
}

/** official_json 本身是数组；m3u8_json / jx_json 是 JSON 字符串 */
export function asLineList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  }
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  } catch {
    return [];
  }
}

/** 把 "0:46:36.760000" 这类时长转成秒 */
export function parseDuration(text: string): number {
  if (!text) return 0;
  let seconds = 0;
  for (const part of text.split(':')) {
    if (part.trim() === '') return 0;
    const value = Number(part);
    if (!Number.isFinite(value)) return 0;
    seconds = seconds * 60 + value;
  }
  return Math.trunc(seconds);
}

/**
 * 按 App 的选路逻辑拼出线路表。
 *
 * 顺序即优先级：主线路 -> 备用线路（镜像）-> 官方线路 -> 备用高清 -> m3u8 线路。
 */
export function playLines(
  bean: Record<string, unknown>,
  secDomain = '',
  wsKey = '',
): PlayLine[] {
  if (!bean || typeof bean !== 'object') return [];

  const lines: PlayLine[] = [];
  const vodUrl = String(bean.vod_url ?? '');

  // 主线路：按 App 原样请求源站，用**当前马甲自己的** CDN 密钥现算 wsSecret。
  // 取流时由本地媒体服务逐分片签名（30 秒时效）。
  if (vodUrl.startsWith('http')) {
    lines.push({
      type: LINE_SIGNED,
      kind: 'signed',
      name: '主线路',
      url: vodUrl,
      ck: parseCk(bean),
      // 取流时由本地媒体服务用这把密钥逐分片现算 wsSecret
      wsKey,
      playable: true,
      note: '',
    });
  }

  // 备用线路：域名换成 sec_domain 镜像站（chw），**不需要签名**。
  // 与主线路指向同一份内容（同 pathname、换域名），可互为容灾。
  const mirrored = mirrorUrl(vodUrl, secDomain);
  if (mirrored) {
    lines.push({
      type: LINE_MIRROR,
      kind: 'mirror',
      name: '备用线路',
      url: mirrored,
      playable: true,
      note: '',
    });
  }

  // 解析前缀固定取 jx_json 的第一条（App 的 index 传 0）
  const jx = asLineList(bean.jx_json);
  const prefix = jx.length ? String(jx[0].url ?? '') : '';

  for (const item of asLineList(bean.official_json)) {
    const target = String(item.url ?? '');
    if (!target) continue;
    lines.push({
      type: LINE_OFFICIAL,
      kind: 'official',
      name: String(item.zname ?? item.name ?? '官方线路'),
      url: '',
      parsePrefix: prefix,
      playable: Boolean(prefix),
      note: prefix ? '' : '这条官方线路没带解析服务，播不了',
    });
  }

  // 备用高清。is_p2p=1 时接口会把地址包成 P2P 形态，
  // 裸地址只会拿到 11 秒占位警告片（且所有剧共用同一个兜底文件）。
  if (vodUrl.startsWith('http')) {
    const placeholder = Number(bean.is_p2p) === 1 && isPlaceholderUrl(vodUrl);
    lines.push({
      type: LINE_BACKUP,
      kind: 'backup',
      name: '备用高清',
      url: vodUrl,
      playable: !placeholder,
      note: placeholder
        ? '接口这次下发的是占位路径（该账号没有真实路径配额），直接播只会拿到一段 11 秒的警告片。'
        : '',
    });
  }

  for (const item of asLineList(bean.m3u8_json)) {
    const url = String(item.url ?? '');
    if (!url.startsWith('http')) continue;
    lines.push({
      type: LINE_M3U8,
      kind: 'm3u8',
      name: String(item.zname ?? item.name ?? 'm3u8 线路'),
      url,
      playable: true,
      note: '',
    });
  }

  return lines;
}

/** 详情里的选集数组 */
export function episodes(detail: Record<string, unknown>): Array<Record<string, unknown>> {
  const list = detail?.vod_collection;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/**
 * 合并真实时长。
 *
 * ★ result_v2 每集回的 duration 是**假的**（同一部剧所有集都是 0:0:19）。
 *   真实时长只有 collection_list_v2 给，两边集 id 一致，按 id 合并。
 */
export function mergeDurations(
  eps: Array<Record<string, unknown>>,
  lengths: Array<Record<string, unknown>>,
): Episode[] {
  const byId = new Map<string, string>();
  for (const row of lengths) {
    byId.set(String(row.id ?? ''), String(row.duration ?? ''));
  }
  return eps.map((bean, index) => {
    const id = String(bean.id ?? '');
    const duration = byId.get(id) || String(bean.duration ?? '');
    return {
      episodeIndex: index,
      // ★ 上游选集 id —— collection_v2 要的就是它，不是下标
      episodeId: id,
      // ★ 上游常只给个裸数字（collection: "1"），补成「第 1 集」
      title: episodeTitle(
        bean.title ?? bean.collection_new_title ?? bean.collection,
        index,
      ),
      vodToken: String(bean.vod_token ?? ''),
      curTime: String(bean.cur_time ?? ''),
      duration,
      durationSec: parseDuration(duration),
    };
  });
}
