/**
 * 源 2 的加密与签名。
 *
 * ★★ 这里是整个项目**最容易踩坑**的地方：一共四条路径，**互不相同**，
 *    不要当成一套。同名但算法完全不同的有两个 `sign`：
 *      - 查询参数 sign：用 MATERIAL_SIGN，key 降序排
 *      - 请求头   sign：用 MD5(uid) 派生 key/iv，不含 material、不含 ts
 *
 * 实现与 `参考/影视站api2.js` 逐字节对齐。
 */
import { aesCbcDecrypt, aesCbcEncrypt } from '../../utils/aes';
import { base64Decode, base64Encode } from '../../utils/base64';
import { fromUtf8, toHex, utf8 } from '../../utils/bytes';
import { md5Bytes } from '../../utils/md5';
import { MATERIAL_DEC, MATERIAL_SIGN, UK_IV, UK_KEY } from './constants';

/** MD5 小写 hex —— 源2 全程用这个形态 */
export const md5hex = (input: string | Uint8Array): string =>
  toHex(md5Bytes(typeof input === 'string' ? utf8(input) : input));

/**
 * 响应解密的密钥派生。
 *
 *   did = MD5(device_uid [+ ts]).hexdigest()
 *   h   = MD5(did + material).hexdigest()
 *   key = h[0:16]   ★ hex 文本的前 16 个 ASCII 字符（**不是二进制摘要**！）
 *   iv  = h[16:32]  ★ hex 文本的后 16 个 ASCII 字符（**不是全 0**！）
 *
 * ★ 切错会解出乱码且**不报任何错**，是整套算法里最难 debug 的一处。
 */
export function deriveKeyIv(
  deviceUid: string,
  ts: number | null,
  material: string = MATERIAL_DEC,
): [Uint8Array, Uint8Array] {
  const src = ts === null || ts === undefined ? deviceUid : deviceUid + ts;
  const did = md5hex(src);
  const h = md5hex(did + material);
  return [utf8(h.slice(0, 16)), utf8(h.slice(16, 32))];
}

/** 解密响应里的 data 字段。ts=null 走 rslvV4 那条路（did 不含 ts） */
export function decrypt(dataB64: string, deviceUid: string, ts: number | null): string {
  const [key, iv] = deriveKeyIv(deviceUid, ts);
  return fromUtf8(aesCbcDecrypt(key, iv, base64Decode(dataB64)));
}

/**
 * **查询参数** sign。
 *
 *   sign = MD5("&k1=v1&k2=v2…" + "&" + MATERIAL_SIGN).hexdigest()
 *   ★ key 按**降序**排；末尾 material 是 type=0 那份
 */
export function makeSign(kv: Record<string, string | number>): string {
  const body = Object.keys(kv)
    .sort()
    .reverse()
    .map((k) => '&' + k + '=' + kv[k])
    .join('');
  return md5hex(body + '&' + MATERIAL_SIGN);
}

/**
 * `uk` 请求头。
 *
 *   uk = Base64( AES-128-CBC-PKCS5(device_uid, key=UK_KEY, iv=UK_IV) )
 *   ★ 密钥是**硬编码常量**，和 sign 头那套完全是两条路
 */
export function makeUk(deviceUid: string): string {
  return base64Encode(aesCbcEncrypt(utf8(UK_KEY), utf8(UK_IV), utf8(deviceUid)));
}

/**
 * 用设备号派生的密钥加密一段文本。
 *
 *   key = MD5(device_uid) 的 hex **前 16 个 ASCII 字符**，iv 是后 16 个
 *   ★ 与 decrypt 同源，但**不含 material**
 */
export function aesD(text: string, deviceUid: string): string {
  const h = md5hex(deviceUid);
  return base64Encode(
    aesCbcEncrypt(utf8(h.slice(0, 16)), utf8(h.slice(16, 32)), utf8(text)),
  );
}

/**
 * **请求头** sign。
 *
 *   sign头 = Base64( AES-128-CBC-PKCS5( 设备信息JSON, key, iv ) )
 *   ★ App 原始 JSON 有 20+ 个设备字段，实测**服务端只认 uid 和 ts**
 */
export function makeSignHeader(deviceUid: string, stampMs?: number): string {
  const ts = stampMs === undefined ? Date.now() : stampMs;
  return aesD(JSON.stringify({ uid: deviceUid, ts }), deviceUid);
}

/** 随机 20 位设备号 */
export function randUid(chars: string): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
