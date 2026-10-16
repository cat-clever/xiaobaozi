/**
 * 源2 设备号轮换策略的回归测试。
 *
 * ★ 背景：源2 上游**按设备号把 CDN 节点钉死** —— 同一个号换多少 IP 都分到
 *   同一个节点，分到哪个是首次请求时随机定的、之后改不回来。全新的号约 1/4
 *   分到快的 https 节点（voldn-ser01），其余分到慢的 http 节点（piccc）。
 *
 *   所以两头都不能走极端：
 *     - 每次启动都换号 → 节点永远不稳
 *     - 永远不换号     → 一次撞上 piccc 就永久慢
 *
 *   策略是"一直慢就记一笔，下次启动换新号"。
 */
import { describe, expect, it, vi } from 'vitest';

// storage.ts 顶层 import 了 RN 的 AsyncStorage，Node 环境跑不了 —— 换成假的
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { SLOW_HITS_BEFORE_ROTATE, shouldRotateDeviceUid } from '../src/utils/storage';

const GOOD_UID = 'nvzATwGTRTY8qN6geDtH'; // 20 位，合法

describe('源2 · 设备号轮换', () => {
  it('没有存过设备号 → 生成新的', () => {
    expect(shouldRotateDeviceUid(null, 0)).toBe(true);
  });

  it('格式不合法（不是 20 位 [0-9A-Za-z]）→ 生成新的', () => {
    expect(shouldRotateDeviceUid('', 0)).toBe(true);
    expect(shouldRotateDeviceUid('too-short', 0)).toBe(true);
    expect(shouldRotateDeviceUid('nvzATwGTRTY8qN6geDt!', 0)).toBe(true); // 含非法字符
    expect(shouldRotateDeviceUid('nvzATwGTRTY8qN6geDtHX', 0)).toBe(true); // 22 位
  });

  it('★ 设备号正常、也没一直慢 → 不换（节点才稳得住）', () => {
    expect(shouldRotateDeviceUid(GOOD_UID, 0)).toBe(false);
    expect(shouldRotateDeviceUid(GOOD_UID, 1)).toBe(false);
  });

  it('★ 连着慢到阈值 → 换新号（重新随机分一次节点）', () => {
    expect(shouldRotateDeviceUid(GOOD_UID, SLOW_HITS_BEFORE_ROTATE)).toBe(true);
    expect(shouldRotateDeviceUid(GOOD_UID, SLOW_HITS_BEFORE_ROTATE + 5)).toBe(true);
  });

  it('阈值是 2 —— 单次拿到 http 不算数（可能是那部剧本身只有 http 源）', () => {
    expect(SLOW_HITS_BEFORE_ROTATE).toBe(2);
    expect(shouldRotateDeviceUid(GOOD_UID, 1)).toBe(false);
  });

  it('计数为负/NaN 时不误换', () => {
    expect(shouldRotateDeviceUid(GOOD_UID, -1)).toBe(false);
    expect(shouldRotateDeviceUid(GOOD_UID, Number.NaN)).toBe(false);
  });
});
