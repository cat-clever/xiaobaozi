/**
 * 字节与文本互转的小工具。
 *
 * 全部自己实现，不依赖 Node 的 Buffer，也不依赖浏览器/RN 的 TextEncoder ——
 * 协议层要能在纯 Node 环境跑单元测试，同时原样跑在 RN 上。
 */

/** UTF-8 编码。手写是为了避免 TextEncoder 在各运行时的可用性差异。 */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // 代理对：合并成一个码点
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
        continue;
      }
      out.push(0xef, 0xbf, 0xbd); // 落单的代理项 -> U+FFFD
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 解码。非法字节按 U+FFFD 处理，不抛异常。 */
export function fromUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    let extra: number;
    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      extra = 1;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      extra = 2;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else {
      out += '�';
      i++;
      continue;
    }
    if (i + extra >= bytes.length) {
      out += '�';
      break;
    }
    let ok = true;
    for (let k = 1; k <= extra; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bytes[i + k] & 0x3f);
    }
    if (!ok) {
      out += '�';
      i++;
      continue;
    }
    i += extra + 1;
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/** 字节数组 -> 小写 hex */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0x0f).toString(16);
  }
  return out;
}

/** hex -> 字节数组。长度为奇数或含非法字符时抛异常。 */
export function fromHex(hexStr: string): Uint8Array {
  if (hexStr.length % 2 !== 0) throw new Error('hex 长度必须是偶数: ' + hexStr.length);
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hexStr.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error('非法 hex 字符: ' + hexStr.substr(i * 2, 2));
    out[i] = byte;
  }
  return out;
}

/** 拼接多段字节 */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 常量时间比较，用于校验类判断 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
