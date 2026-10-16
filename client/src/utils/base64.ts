/**
 * Base64 / Base64URL —— 纯 TypeScript 实现。
 *
 * 不依赖 Buffer（Node 专有）或 btoa/atob（浏览器与 RN 行为略有差异），
 * 保证协议层在 Node 测试环境与 RN 运行时结果完全一致。
 */

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const STD_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < STD_ALPHABET.length; i++) t[STD_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

function encodeWith(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : pad ? '=' : '';
    out += i + 2 < bytes.length ? alphabet[b2 & 0x3f] : pad ? '=' : '';
  }
  return out;
}

function decodeWith(text: string): Uint8Array {
  // 容错：URL-safe 变体、空白、缺失补位都能解
  const clean = text.replace(/[-_]/g, (ch) => (ch === '-' ? '+' : '/')).replace(/[^A-Za-z0-9+/]/g, '');
  const outLen = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = STD_LOOKUP[clean.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

/** 标准 Base64（带 = 补位） */
export const base64Encode = (bytes: Uint8Array): string => encodeWith(bytes, STD_ALPHABET, true);

/** 标准 Base64 解码，容忍 URL-safe 字符与缺失补位 */
export const base64Decode = (text: string): Uint8Array => decodeWith(text);

/** Base64URL（不带 = 补位）—— 源1 的 `ck` 字段用的就是这种 */
export const base64UrlEncode = (bytes: Uint8Array): string => encodeWith(bytes, URL_ALPHABET, false);

/** Base64URL 解码 */
export const base64UrlDecode = (text: string): Uint8Array => decodeWith(text);
