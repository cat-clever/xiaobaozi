/**
 * AES-128/192/256 + CBC + PKCS#7 —— 纯 TypeScript 实现。
 *
 * 为什么不用 WebCrypto / 原生模块：
 *   1. WebCrypto 在 React Native 上默认不存在，需要额外 polyfill 或原生模块；
 *   2. 协议层必须能在纯 Node 环境跑单元测试，与 `参考/` 里的实现逐字节对答案；
 *   3. 这里的密钥是 16 / 32 字节、数据量是 KB 级，纯 TS 的吞吐完全够用。
 *
 * 后续若成为瓶颈，可在**保持本文件导出接口不变**的前提下替换为原生实现
 * （见项目文档 §3.3 与 §7.2 的性能预算）。
 *
 * S-box 由 GF(2^8) 逆元 + 仿射变换**程序化生成**，而非抄写常量表 ——
 * 避免转录错误，也让逆 S-box 与正 S-box 天然一致。
 */

/** GF(2^8) 乘法，模多项式 0x11b */
function gmul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

const SBOX: Uint8Array = (() => {
  // 乘法逆元表（0 的逆元定义为 0）
  const inv = new Uint8Array(256);
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) {
      if (gmul(i, j) === 1) {
        inv[i] = j;
        break;
      }
    }
  }
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = inv[i];
    const rot = (n: number): number => ((x << n) | (x >>> (8 - n))) & 0xff;
    s[i] = (x ^ rot(1) ^ rot(2) ^ rot(3) ^ rot(4) ^ 0x63) & 0xff;
  }
  return s;
})();

const INV_SBOX: Uint8Array = (() => {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[SBOX[i]] = i;
  return inv;
})();

/** 轮密钥扩展，返回按轮拼接的轮密钥（每轮 16 字节） */
function expandKey(key: Uint8Array): { rk: Uint8Array; rounds: number } {
  const Nk = key.length / 4; // 4 / 6 / 8
  const Nr = Nk + 6; // 10 / 12 / 14
  const w = new Uint8Array(16 * (Nr + 1));
  w.set(key);

  let rcon = 1;
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let t0 = w[(i - 1) * 4];
    let t1 = w[(i - 1) * 4 + 1];
    let t2 = w[(i - 1) * 4 + 2];
    let t3 = w[(i - 1) * 4 + 3];

    if (i % Nk === 0) {
      // RotWord -> SubWord -> 异或 Rcon
      const first = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[first];
      rcon = gmul(rcon, 2);
    } else if (Nk > 6 && i % Nk === 4) {
      // AES-256 独有的额外 SubWord
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }

    w[i * 4] = w[(i - Nk) * 4] ^ t0;
    w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ t1;
    w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ t2;
    w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ t3;
  }
  return { rk: w, rounds: Nr };
}

/** 状态按列优先排布：s[r + 4c] */
function shiftRows(s: Uint8Array): void {
  let t = s[1];
  s[1] = s[5];
  s[5] = s[9];
  s[9] = s[13];
  s[13] = t;

  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;

  t = s[3];
  s[3] = s[15];
  s[15] = s[11];
  s[11] = s[7];
  s[7] = t;
}

function invShiftRows(s: Uint8Array): void {
  let t = s[13];
  s[13] = s[9];
  s[9] = s[5];
  s[5] = s[1];
  s[1] = t;

  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;

  t = s[3];
  s[3] = s[7];
  s[7] = s[11];
  s[11] = s[15];
  s[15] = t;
}

function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i];
    const a1 = s[i + 1];
    const a2 = s[i + 2];
    const a3 = s[i + 3];
    s[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

function invMixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i];
    const a1 = s[i + 1];
    const a2 = s[i + 2];
    const a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

function encryptBlock(rk: Uint8Array, rounds: number, block: Uint8Array, out: Uint8Array): void {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ rk[i];

  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s);
    if (round !== rounds) mixColumns(s);
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
  }
  out.set(s);
}

function decryptBlock(rk: Uint8Array, rounds: number, block: Uint8Array, out: Uint8Array): void {
  const s = new Uint8Array(16);
  const last = rounds * 16;
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ rk[last + i];

  for (let round = rounds - 1; round >= 0; round--) {
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
    if (round !== 0) invMixColumns(s);
  }
  out.set(s);
}

/**
 * AES-CBC 加密，自动补 PKCS#7。
 *
 * 密钥长度必须是 16 / 24 / 32 字节，IV 必须是 16 字节。
 */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error('AES IV 必须是 16 字节，实际 ' + iv.length);
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error('AES 密钥必须是 16 / 24 / 32 字节，实际 ' + key.length);
  }

  // PKCS#7 补位：永远补，即使长度正好是 16 的倍数也要补一整块
  const padLen = 16 - (plaintext.length % 16);
  const padded = new Uint8Array(plaintext.length + padLen);
  padded.set(plaintext);
  padded.fill(padLen, plaintext.length);

  const { rk, rounds } = expandKey(key);
  const out = new Uint8Array(padded.length);
  const prev = new Uint8Array(iv);
  const block = new Uint8Array(16);

  for (let off = 0; off < padded.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = padded[off + i] ^ prev[i];
    encryptBlock(rk, rounds, block, block);
    out.set(block, off);
    prev.set(block);
  }
  return out;
}

/**
 * AES-CBC 解密，自动剥 PKCS#7。
 *
 * 补位非法时抛异常 —— 上游密钥/IV 配错时这里会失败，
 * 属于"必须显式暴露"的错误，不要静默返回乱码。
 */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error('AES IV 必须是 16 字节，实际 ' + iv.length);
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error('AES 密钥必须是 16 / 24 / 32 字节，实际 ' + key.length);
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('密文长度必须是 16 的正整数倍，实际 ' + ciphertext.length);
  }

  const { rk, rounds } = expandKey(key);
  const out = new Uint8Array(ciphertext.length);
  const prev = new Uint8Array(iv);
  const block = new Uint8Array(16);

  for (let off = 0; off < ciphertext.length; off += 16) {
    block.set(ciphertext.subarray(off, off + 16));
    decryptBlock(rk, rounds, block, block);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev.set(ciphertext.subarray(off, off + 16));
  }

  const padLen = out[out.length - 1];
  if (padLen < 1 || padLen > 16 || padLen > out.length) {
    throw new Error('PKCS#7 补位非法（' + padLen + '）—— 密钥或 IV 很可能不对');
  }
  for (let i = out.length - padLen; i < out.length; i++) {
    if (out[i] !== padLen) {
      throw new Error('PKCS#7 补位字节不一致 —— 密钥或 IV 很可能不对');
    }
  }
  return out.subarray(0, out.length - padLen);
}
