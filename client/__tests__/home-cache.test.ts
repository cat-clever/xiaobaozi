/**
 * 首页缓存的回归测试。
 *
 * ★ 背景：进详情页 / 播放页时整个 Tab 树会卸载，返回时首页重新挂载 ——
 *   没有缓存的话每次返回都要重拉两个源（源2 一次回 300 多条），又慢又费流量。
 *   用户的要求是：**首次加载后就留着，只有下拉刷新才重新取**。
 *
 * 这里锁住三件事：第二次不再打上游、force 才重打、失败的空结果不进缓存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  s1HomeFeed: vi.fn(),
  s2HomeFeed: vi.fn(),
}));

vi.mock('../src/api/source1', () => ({
  homeFeed: mocks.s1HomeFeed,
  hotSearch: vi.fn(),
  categoryTree: vi.fn(),
  filterRowsFor: vi.fn(),
  search: vi.fn(),
  listByCategory: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('../src/api/source2', () => ({
  homeFeed: mocks.s2HomeFeed,
  stars: vi.fn(),
  starWorks: vi.fn(),
  categoryTree: vi.fn(),
  search: vi.fn(),
  listByCategory: vi.fn(),
  detail: vi.fn(),
}));

import { clearHomeCache, homeBlocksOf, peekHomeBlocks } from '../src/api/aggregator';

const 源1板块 = [{ title: '全网热门', items: [{ id: 's1_1' }] }];
const 源2板块 = [{ title: '热门推荐', items: [{ id: 's2_1' }] }];

describe('首页缓存', () => {
  beforeEach(() => {
    clearHomeCache();
    mocks.s1HomeFeed.mockReset();
    mocks.s2HomeFeed.mockReset();
    mocks.s1HomeFeed.mockResolvedValue(源1板块);
    mocks.s2HomeFeed.mockResolvedValue(源2板块);
  });

  it('第一次会打上游，并带上源标签', async () => {
    const blocks = await homeBlocksOf('s1');
    expect(mocks.s1HomeFeed).toHaveBeenCalledTimes(1);
    expect(blocks[0].title).toBe('全网源 · 全网热门');
  });

  it('★ 第二次不再打上游，直接返回缓存', async () => {
    await homeBlocksOf('s1');
    const again = await homeBlocksOf('s1');

    expect(mocks.s1HomeFeed).toHaveBeenCalledTimes(1); // 还是 1 次
    expect(again[0].items[0].id).toBe('s1_1');
  });

  it('★ 两个源各自缓存，互不影响', async () => {
    await homeBlocksOf('s1');
    await homeBlocksOf('s2');
    await homeBlocksOf('s1');
    await homeBlocksOf('s2');

    expect(mocks.s1HomeFeed).toHaveBeenCalledTimes(1);
    expect(mocks.s2HomeFeed).toHaveBeenCalledTimes(1);
  });

  it('★ force=true（下拉刷新）会重新打', async () => {
    await homeBlocksOf('s1');
    await homeBlocksOf('s1', 1, true);

    expect(mocks.s1HomeFeed).toHaveBeenCalledTimes(2);
  });

  it('peekHomeBlocks 同步就能拿到，没缓存时返回 null', async () => {
    expect(peekHomeBlocks('s1')).toBeNull();
    await homeBlocksOf('s1');
    expect(peekHomeBlocks('s1')?.[0].title).toBe('全网源 · 全网热门');
  });

  it('★ 上游回空结果时不写缓存 —— 否则下次就一直是空的', async () => {
    mocks.s1HomeFeed.mockResolvedValue([]);
    await homeBlocksOf('s1');

    expect(peekHomeBlocks('s1')).toBeNull();
    await homeBlocksOf('s1');
    expect(mocks.s1HomeFeed).toHaveBeenCalledTimes(2); // 会重试
  });
});
