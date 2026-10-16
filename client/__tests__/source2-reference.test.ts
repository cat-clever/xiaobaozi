/**
 * 源 2 协议层 —— 与**录制自参考实现的黄金向量**逐字节对答案。
 *
 * 为什么不直接 import 参考实现：`参考/` 目录**不进仓库**（它含全部密钥），
 * 所以把参考实现的输出固化成向量提交进来，CI 就能离线校验。
 * 向量由 `参考/影视站api2.js` 录制，见 `__tests__/vectors/source2-golden.json`。
 *
 * 重点覆盖四条互不相同的路径 —— 尤其是两个同名但算法完全不同的 `sign`。
 */
import { describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';

import {
  aesD,
  decrypt,
  deriveKeyIv,
  makeSign,
  makeSignHeader,
  makeUk,
  md5hex,
} from '../src/api/source2/crypto';
import { base64Encode } from '../src/utils/base64';
import { toHex, utf8 } from '../src/utils/bytes';
import golden from './vectors/source2-golden.json';

const UID = 'nvzATwGTRTY8qN6geDtH';
const UID2 = 'jciRRolL4MVuzAWRvUTE';

describe('源2 · 黄金向量完整性', () => {
  it('向量文件非空（防止误删后测试静默通过）', () => {
    expect(Object.keys(golden.md5).length).toBeGreaterThan(0);
    expect(golden.deriveKeyIv.length).toBeGreaterThan(0);
    expect(Object.keys(golden.uk).length).toBeGreaterThan(0);
    expect(golden.sign.length).toBeGreaterThan(0);
    expect(golden.signHeader.length).toBeGreaterThan(0);
  });
});

describe('源2 · md5hex', () => {
  it('与参考实现的输出逐字节一致', () => {
    for (const [input, expected] of Object.entries(golden.md5)) {
      expect(md5hex(input), JSON.stringify(input.slice(0, 30))).toBe(expected);
    }
  });
});

describe('源2 · 路径一：响应解密的密钥派生', () => {
  it('key/iv 与参考实现一致', () => {
    for (const v of golden.deriveKeyIv) {
      const [key, iv] = deriveKeyIv(v.uid, v.ts);
      expect(toHex(key), `${v.uid}@${v.ts}`).toBe(v.key);
      expect(toHex(iv), `${v.uid}@${v.ts}`).toBe(v.iv);
    }
  });

  it('★ key/iv 取的是 hex 文本切片，不是二进制摘要；iv 也不是全 0', () => {
    const [key, iv] = deriveKeyIv(UID, null);

    // key 必须是 16 个可打印的 hex ASCII 字符
    const keyText = String.fromCharCode(...key);
    expect(keyText).toMatch(/^[0-9a-f]{16}$/);
    expect(keyText).toBe(md5hex(md5hex(UID) + '34F9Q53w/HJW8E6Q').slice(0, 16));

    // iv 同样，且不是全 0
    const ivText = String.fromCharCode(...iv);
    expect(ivText).toMatch(/^[0-9a-f]{16}$/);
    expect(iv.some((b) => b !== 0)).toBe(true);
  });
});

describe('源2 · 路径二：查询参数 sign', () => {
  it('与参考实现一致（key 降序排 + 末尾拼 MATERIAL_SIGN）', () => {
    for (const v of golden.sign) {
      expect(makeSign(v.kv as Record<string, string | number>), JSON.stringify(v.kv)).toBe(v.value);
    }
  });

  it('确实是降序而非升序', () => {
    const desc = makeSign({ a: '1', z: '2' });
    const asc = md5hex('&a=1&z=2&' + '2E159Q/Z8979WckQ');
    expect(desc).not.toBe(asc);
    expect(desc).toBe(md5hex('&z=2&a=1&' + '2E159Q/Z8979WckQ'));
  });
});

describe('源2 · 路径三：uk 请求头（硬编码密钥）', () => {
  it('与参考实现一致，且与 sign 头那条路不同', () => {
    for (const [uid, expected] of Object.entries(golden.uk)) {
      expect(makeUk(uid), uid).toBe(expected);
      expect(makeUk(uid)).not.toBe(makeSignHeader(uid, 1750000000000));
    }
  });
});

describe('源2 · 路径四：sign 请求头（MD5(uid) 派生，不含 material/ts）', () => {
  it('与参考实现一致', () => {
    for (const v of golden.signHeader) {
      expect(makeSignHeader(v.uid, v.ts), `${v.uid}@${v.ts}`).toBe(v.value);
    }
  });

  it('aesD 确定性，且与 uk 路径互不相同', () => {
    const a = aesD('hello', UID);
    expect(a).toBe(aesD('hello', UID));
    expect(a).not.toBe(aesD('hello!', UID));
    expect(a).not.toBe(makeUk(UID));
    expect(md5hex(UID).slice(0, 16)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('源2 · decrypt 端到端', () => {
  it('能解开按参考派生规则加密的密文', async () => {
    const plain = JSON.stringify({ code: 0, data: { name: '超异能族', list: [1, 2, 3] } });

    for (const ts of [null, 1750000000]) {
      const [key, iv] = deriveKeyIv(UID, ts);
      const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
      const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
      const b64 = base64Encode(new Uint8Array(ct));

      expect(decrypt(b64, UID, ts)).toBe(plain);
    }
  });

  it('设备号用错时解不出原文（锁住"uid 是密钥的一半"）', () => {
    const plain = JSON.stringify({ data: '超异能族' });
    const [key, iv] = deriveKeyIv(UID, null);
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
    const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);

    expect(() => decrypt(base64Encode(new Uint8Array(ct)), UID2, null)).toThrow();
  });
});

describe('源2 · 常量', () => {
  it('设备号是 20 位', () => {
    expect(utf8(UID).length).toBe(20);
  });
});
