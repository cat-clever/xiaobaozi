/**
 * 选集标题的回归测试。
 *
 * ★ 规则：**有名字就用名字，没有就用数字**。
 *
 * 实测上游给的东西很杂：
 *   - 源1 常只给裸数字（collection: "1"）—— 没名字
 *   - 源2 有的剧整条**没有 title 字段**（《心动制造所》），有的是空串，
 *     有的给真名字（《背着善宰跑》的「重回十九岁」）
 */
import { describe, expect, it } from 'vitest';

import { episodeTitle } from '../src/utils/episode';

describe('选集标题', () => {
  it('★ 没有名字就用数字', () => {
    // 源2《心动制造所》那几条：整条没有 title 字段
    expect(episodeTitle(undefined, 0)).toBe('1');
    expect(episodeTitle(undefined, 1)).toBe('2');
    // 也有给空串的
    expect(episodeTitle('', 2)).toBe('3');
    expect(episodeTitle('   ', 3)).toBe('4');
    expect(episodeTitle(null, 9)).toBe('10');
  });

  it('★ 裸数字归一化（去掉前导零），不当成名字', () => {
    // 源1 的 collection 字段
    expect(episodeTitle('1', 0)).toBe('1');
    expect(episodeTitle('01', 0)).toBe('1');
    expect(episodeTitle('10', 9)).toBe('10');
    expect(episodeTitle(3, 2)).toBe('3');
  });

  it('★★ 有名字的必须原样保留', () => {
    // 源2《背着善宰跑》实测回来的
    expect(episodeTitle('重回十九岁', 0)).toBe('重回十九岁');
    expect(episodeTitle('无法扭转的未来？', 1)).toBe('无法扭转的未来？');
    // 综艺的期数文案
    const 综艺 = '第1期花絮特辑：“沙滩小黑脚”加赛版全员混战';
    expect(episodeTitle(综艺, 0)).toBe(综艺);
    expect(episodeTitle('更新至第2集', 1)).toBe('更新至第2集');
    expect(episodeTitle('预告', 0)).toBe('预告');
  });

  it('带数字但不是纯数字的不动', () => {
    expect(episodeTitle('1-2', 0)).toBe('1-2');
    expect(episodeTitle('第 3 集', 2)).toBe('第 3 集');
  });
});
