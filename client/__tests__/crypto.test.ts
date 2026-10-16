/**
 * 加密基座的交叉验证。
 *
 * 基准是 **Node 内置 crypto**（MD5 / AES-CBC 都是标准算法），
 * 而不是"我自己跑一遍看结果对不对"——这样任何实现偏差都会被抓住。
 */
import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { md5Bytes } from '../src/utils/md5';
import { aesCbcDecrypt, aesCbcEncrypt } from '../src/utils/aes';
import { base64Decode, base64Encode, base64UrlEncode } from '../src/utils/base64';
import { concat, fromHex, fromUtf8, toHex, utf8 } from '../src/utils/bytes';

const nodeMd5 = (input: Uint8Array): string =>
  createHash('md5').update(Buffer.from(input)).digest('hex');

describe('MD5', () => {
  it('与 Node 内置 crypto 对答案（含边界与 UTF-8）', () => {
    const cases: string[] = [
      '',
      'a',
      'abc',
      'message digest',
      'abcdefghijklmnopqrstuvwxyz',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '小包子影视',                        // 多字节 UTF-8
      'zD9[bM4~sF4~uY2)96ab557f6826febf1750000000000',  // 贴近源1 签名头的真实形态
      'a'.repeat(55),                     // 补位边界
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(1000),
    ];
    for (const c of cases) {
      expect(toHex(md5Bytes(utf8(c))), `MD5(${JSON.stringify(c.slice(0, 40))})`).toBe(
        nodeMd5(utf8(c)),
      );
    }
  });

  it('接受字节数组输入（非字符串）', () => {
    const bytes = randomBytes(133);
    expect(toHex(md5Bytes(new Uint8Array(bytes)))).toBe(nodeMd5(new Uint8Array(bytes)));
  });
});

describe('AES-CBC', () => {
  const nodeEncrypt = (key: Uint8Array, iv: Uint8Array, pt: Uint8Array): Uint8Array => {
    const c = createCipheriv(`aes-${key.length * 8}-cbc`, Buffer.from(key), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([c.update(Buffer.from(pt)), c.final()]));
  };
  const nodeDecrypt = (key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Uint8Array => {
    const d = createDecipheriv(`aes-${key.length * 8}-cbc`, Buffer.from(key), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
  };

  it('三种密钥长度都能与 Node 互相加解密', () => {
    for (const keyLen of [16, 24, 32]) {
      for (const ptLen of [0, 1, 15, 16, 17, 31, 32, 33, 100, 1000]) {
        const key = new Uint8Array(randomBytes(keyLen));
        const iv = new Uint8Array(randomBytes(16));
        const pt = new Uint8Array(randomBytes(ptLen));

        // 我加密 -> Node 解密
        const mine = aesCbcEncrypt(key, iv, pt);
        expect(toHex(nodeDecrypt(key, iv, mine)), `aes-${keyLen * 8} pt=${ptLen}`).toBe(toHex(pt));

        // Node 加密 -> 我解密（同时验证 PKCS#7 剥离）
        const theirs = nodeEncrypt(key, iv, pt);
        expect(toHex(aesCbcDecrypt(key, iv, theirs))).toBe(toHex(pt));

        // 密文本身必须逐字节一致
        expect(toHex(mine)).toBe(toHex(theirs));
      }
    }
  });

  it('源1 的真实形态：AES-256 + 固定 key/iv + UTF-8 中文', () => {
    // 取值形态与 参考/影视站api1.js 的 AES_KEY / AES_IV 一致（长度与字符集）
    const key = utf8('aZ9$kU5%qI7=yC2=zH2#gM0@pX7^wF3a');
    const iv = utf8('hY2&tN3]kF7,dL7=');
    expect(key.length).toBe(32);
    expect(iv.length).toBe(16);

    const plain = utf8('{"code":10000,"message":"成功","data":{"vod_name":"小包子影视"}}');
    const ct = aesCbcEncrypt(key, iv, plain);
    expect(toHex(aesCbcDecrypt(key, iv, ct))).toBe(toHex(plain));
    expect(toHex(ct)).toBe(toHex(nodeEncrypt(key, iv, plain)));
  });

  it('密钥或 IV 错误时抛出可诊断的异常，而不是返回乱码', () => {
    const key = new Uint8Array(randomBytes(16));
    const iv = new Uint8Array(randomBytes(16));
    const ct = aesCbcEncrypt(key, iv, utf8('小包子影视'));

    const wrongKey = new Uint8Array(randomBytes(16));
    expect(() => aesCbcDecrypt(wrongKey, iv, ct)).toThrow(/密钥或 IV/);
  });

  it('拒绝非法长度', () => {
    const k16 = new Uint8Array(16);
    const iv16 = new Uint8Array(16);
    expect(() => aesCbcEncrypt(new Uint8Array(15), iv16, utf8('x'))).toThrow(/密钥/);
    expect(() => aesCbcEncrypt(k16, new Uint8Array(15), utf8('x'))).toThrow(/IV/);
    expect(() => aesCbcDecrypt(k16, iv16, new Uint8Array(15))).toThrow(/密文/);
  });
});

describe('Base64', () => {
  it('标准 Base64 与 Node Buffer 一致', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 100]) {
      const bytes = new Uint8Array(randomBytes(len));
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('解码容忍 URL-safe 字符与缺失补位', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x3e, 0x3f]);
    const std = base64Encode(bytes);
    const url = base64UrlEncode(bytes);
    expect(toHex(base64Decode(std))).toBe(toHex(bytes));
    expect(toHex(base64Decode(url))).toBe(toHex(bytes));
    expect(url.includes('=')).toBe(false);
  });

  it('源1 的 ck 字段形态：base64url -> 明文 query', () => {
    const plain = 'k=abc123&Time=1750000000&uid=96ab557f6826febf';
    const encoded = base64UrlEncode(utf8(plain));
    expect(fromUtf8(base64Decode(encoded))).toBe(plain);
  });
});

describe('bytes 工具', () => {
  it('hex 往返', () => {
    const bytes = new Uint8Array(randomBytes(64));
    expect(toHex(fromHex(toHex(bytes)))).toBe(toHex(bytes));
  });

  it('UTF-8 往返（含代理对）', () => {
    for (const s of ['', 'abc', '小包子影视', '🎬🍿', '한국 드라마', 'a🎬b小c']) {
      expect(fromUtf8(utf8(s))).toBe(s);
    }
  });

  it('concat 保持顺序', () => {
    expect(toHex(concat(fromHex('01'), fromHex('0203'), fromHex('04')))).toBe('01020304');
  });
});
