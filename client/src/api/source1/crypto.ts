/**
 * 源 1 的加密与签名。
 *
 * 全部与 `参考/影视站api1.js` 逐字节对齐，单元测试用固定向量锁住行为。
 */
import { aesCbcDecrypt } from '../../utils/aes';
import { base64Decode } from '../../utils/base64';
import { fromUtf8, toHex, utf8 } from '../../utils/bytes';
import { md5Bytes } from '../../utils/md5';
import { ApiError, ServerBusyError } from '../errors';
import { AES_IV, AES_KEY, API_UA, SIGN_SALT, SUCCESS_CODE, SYS_PLATFORM } from './constants';
import type { MahaoEntry } from './constants';

/** MD5 小写 hex */
const md5hex = (s: string): string => toHex(md5Bytes(utf8(s)));

/** MD5 大写 hex —— 签名头用的是这个 */
const md5hexUpper = (s: string): string => md5hex(s).toUpperCase();

/**
 * 请求签名头。
 *
 * `sign = MD5(SIGN_SALT + device_id + cur_time)` 大写 hex。
 * ★ 少一个字节都会被服务端判为无效请求。
 */
export function buildHeaders(
  entry: MahaoEntry,
  deviceId: string,
  token: string,
  curTime: number,
): Record<string, string> {
  const raw = SIGN_SALT + deviceId + String(curTime);
  return {
    app_id: entry.appId,
    package_name: entry.packageName,
    version: entry.version,
    sys_platform: SYS_PLATFORM,
    mob_mfr: 'xiaomi',
    mobmodel: 'MI 9',
    sysrelease: '10',
    device_id: deviceId,
    channel_code: entry.channelCode,
    cur_time: String(curTime),
    token,
    sign: md5hexUpper(raw),
    'User-Agent': API_UA,
  };
}

/**
 * CDN 签名。
 *
 * `wsSecret = MD5(ws_key + path + wsTime_hex)` **小写** hex。
 *
 * ★ 只有 30 秒有效期 —— 必须在**每次取流时现算**，不可缓存、不可预生成。
 */
export function wsSecret(path: string, ts: number, key: string): string {
  return md5hex(key + path + (ts >>> 0).toString(16));
}

/**
 * 给 path 拼签名。
 *
 * ★ 原来 query 里的 wsSecret / wsTime 会被剔掉 —— 留着会撞 462。
 * ★ `ck`（`k=..&Time=..&uid=..`）**必须**拼进 query 一起参与签名，
 *   少它源站回 463（签名本身对，但访问凭证缺了）。
 */
export function signQuery(
  path: string,
  query: string,
  ts: number | null,
  key: string,
): string {
  const t = ts ?? Math.floor(Date.now() / 1000);
  const kept = String(query || '')
    .split('&')
    .filter((kv) => {
      if (!kv) return false;
      const k = kv.split('=')[0];
      return k !== 'wsSecret' && k !== 'wsTime';
    });
  kept.push('wsSecret=' + wsSecret(path, t, key) + '&wsTime=' + t.toString(16));
  return kept.join('&');
}

const RE_BASE64 = /^[A-Za-z0-9+/=\s]+$/;

/**
 * 把响应体解成对象。
 *
 * 正常是 `base64(AES-CBC(json))`；服务端出错时会直接回**中文明文**，
 * 这里单独抛 ServerBusyError，让上层知道"是被挡了"而不是"协议不对"。
 */
export function decodeBody(text: string): Record<string, unknown> {
  const body = (text || '').trim();
  if (!body) throw new ServerBusyError('空响应');

  if (body[0] === '{' || body[0] === '[') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      // 不是 JSON，往下当加密体处理
    }
  }

  if (!RE_BASE64.test(body)) throw new ServerBusyError(body.slice(0, 120));

  const raw = base64Decode(body);
  const plain = fromUtf8(aesCbcDecrypt(utf8(AES_KEY), utf8(AES_IV), raw));
  try {
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    throw new ApiError('解密后不是 JSON: ' + plain.slice(0, 200));
  }
}

/** 校验业务成功码，返回 data 字段 */
export function unwrap(data: Record<string, unknown>): Record<string, unknown> {
  const code = Number(data.code);
  if (code !== SUCCESS_CODE) {
    throw new ApiError(`接口返回 code=${code} message=${String(data.message ?? '')}`);
  }
  const result = data.result ?? data.data;
  return (result ?? {}) as Record<string, unknown>;
}

/**
 * 解析 `ck` 字段。
 *
 * collection_v2 回的 ck 是 base64url，解开是 `k=..&Time=..&uid=..`，
 * 签名后要拼在地址后面。
 */
export function parseCk(bean: Record<string, unknown>): string {
  const ck = String(bean?.ck ?? '');
  if (!ck) return '';
  try {
    return fromUtf8(base64Decode(ck));
  } catch {
    return '';
  }
}
