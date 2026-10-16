/**
 * 本地媒体服务的**分片命名**回归测试。
 *
 * ★ 为什么要单测这一层：投屏时那个后缀直接决定接收端会不会去走本地换封装，
 *   而那条路在 Android 电视上会让接收端**崩**（2026-10-16 真机踩到）。
 *   命名是纯字符串逻辑，不用真机就能验。
 */
import { describe, expect, it } from 'vitest';

import { basenameOf, localSegmentName } from '../src/media/segmentNaming';

describe('basenameOf：取最后一段当文件名', () => {
  it('带后缀的原样用', () => {
    expect(basenameOf('http://h/a/b/output_000000.ts')).toBe('output_000000.ts');
    expect(basenameOf('http://h/index.m3u8')).toBe('index.m3u8');
  });

  it('★ 查询串不参与 —— 签名线路的分片地址普遍带 ?m8=...', () => {
    expect(basenameOf('http://h/output_000000.ts?m8=abc&sz=12')).toBe('output_000000.ts');
  });

  it('没有后缀就补 .ts', () => {
    expect(basenameOf('http://h/seg')).toBe('seg.ts');
    // 路径以 / 结尾时最后一段是空的 —— 用 index 兜底（沿用原行为）
    expect(basenameOf('http://h/a/')).toBe('index.ts');
  });

  it('不是合法地址也有个兜底名字', () => {
    expect(basenameOf('乱写')).toBe('seg.ts');
  });
});

describe('localSegmentName：三种会话的后缀规则', () => {
  const plain = { remuxing: false, forCast: false };
  const remuxing = { remuxing: true, forCast: false };
  const casting = { remuxing: false, forCast: true };

  it('本地播放：一字不动（行为跟加投屏之前完全一致）', () => {
    expect(localSegmentName('http://h/output_000000.ts', plain)).toBe('output_000000.ts');
    expect(localSegmentName('http://h/clip.mp4', plain)).toBe('clip.mp4');
  });

  it('转封装会话：如实报 .m4s（内容已经是 fMP4 了）', () => {
    expect(localSegmentName('http://h/output_000000.ts', remuxing)).toBe('output_000000.m4s');
    expect(localSegmentName('http://h/clip.mp4', remuxing)).toBe('clip.mp4');
  });

  it('★★ 投屏会话：把 .ts 去掉 —— 接收端据此判"认不出来"，不走换封装', () => {
    expect(localSegmentName('http://h/output_000000.ts', casting)).toBe('output_000000');
    // 带签名的分片一样要中招（接收端那边会先把 query 剥掉再判后缀）
    expect(localSegmentName('http://h/output_000000.ts?m8=abc', casting)).toBe('output_000000');
  });

  it('投屏只动 .ts，别的后缀不碰', () => {
    expect(localSegmentName('http://h/index.m3u8', casting)).toBe('index.m3u8');
    expect(localSegmentName('http://h/clip.mp4', casting)).toBe('clip.mp4');
    expect(localSegmentName('http://h/enc.key', casting)).toBe('enc.key');
  });

  it('★ 去掉后缀后不能变成空名字', () => {
    // 极端输入：文件名只有 ".ts"。宁可保留原名也不要给个空段 ——
    // 空段会让本地地址少一级，原生那边的路由解析直接 404。
    expect(localSegmentName('http://h/.ts', casting)).toBe('.ts');
  });
});
