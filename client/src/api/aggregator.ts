/**
 * 双源聚合器。
 *
 * 把两个上游的差异抹平成统一的 DTO，UI 层只认 `VodItem` / `VodDetail`。
 * 并发检索时**任一源失败不影响另一源** —— 单源挂掉是常态，不能连坐。
 */
import * as s1 from './source1';
import * as s2 from './source2';
import type { SourceId, VodDetail, VodItem } from '../types/schema';

export interface HomeBlock {
  title: string;
  items: VodItem[];
}

/** 源在 UI 上的叫法，只此一处 */
export const SOURCE_LABEL: Record<SourceId, string> = { s1: '全网源', s2: '精选源' };

export const sourceLabel = (id: SourceId): string => SOURCE_LABEL[id];

/** 并发跑两个源，失败的当空结果（但记录原因） */
async function settle<T>(task: Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> {
  try {
    return { value: await task, error: null };
  } catch (err) {
    return { value: fallback, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 首页缓存（**进程内**，App 不关就一直有效）。
 *
 * ★ 为什么要它：进详情页 / 播放页时整个 Tab 树会卸载，返回时重新挂载 ——
 *   首页就整轮重拉了。而首页本来就要打两个源、源2 一次还回 300 多条，
 *   每次返回都重来一遍既慢又费流量。
 *
 *   按用户的要求：**首次加载后就留着，只有下拉刷新才重新取**。
 *   不设 TTL —— App 不关就一直用，这也意味着首页可能显示的是几小时前的内容，
 *   下拉一下就能刷。
 */
const homeCache = new Map<string, HomeBlock[]>();

const cacheKey = (sourceId: SourceId, page: number): string => `${sourceId}|${page}`;

/**
 * 同步看一眼缓存里有没有 —— 首页用它决定首屏要不要出骨架屏，
 * 有缓存就直接画，连一帧骨架都不闪。
 */
export function peekHomeBlocks(sourceId: SourceId, page = 1): HomeBlock[] | null {
  return homeCache.get(cacheKey(sourceId, page)) ?? null;
}

/** 下拉刷新之外的场景也可以手动清（目前只有测试用） */
export function clearHomeCache(): void {
  homeCache.clear();
}

/**
 * **单个源**的首页推荐块。
 *
 * ★ 首页必须按源分别取，不能在 `home()` 里等两家都回来 ——
 *   实测（2026-10-15）源2 一个板块就有 90 条，两源齐活要等好几秒，
 *   慢的那家会把首屏整个拖住。UI 拿到这个接口后，谁先回来谁先上屏。
 *
 * @param force 跳过缓存重新取 —— 下拉刷新走这条
 */
export async function homeBlocksOf(
  sourceId: SourceId,
  page = 1,
  force = false,
): Promise<HomeBlock[]> {
  const key = cacheKey(sourceId, page);
  if (!force) {
    const hit = homeCache.get(key);
    if (hit) return hit;
  }

  const blocks = sourceId === 's1' ? await s1.homeFeed(page) : await s2.homeFeed(page);
  const normalized = blocks.map((b) => ({
    ...b,
    title: `${SOURCE_LABEL[sourceId]} · ${b.title}`,
  }));

  // 只在真的拿到内容时才写缓存 —— 失败的空结果存进去，下次就一直是空的
  if (normalized.length) homeCache.set(key, normalized);
  return normalized;
}

/**
 * 首页：两源并发拉取，按源分组展示。
 *
 * 返回的 `errors` 供 UI 提示"某个源暂时不可用"，而不是静默少一半内容。
 * ★ 新 UI 请用 `homeBlocksOf()` 分别取 —— 这个聚合入口会等两家都回来。
 */
export async function home(page = 1): Promise<{ blocks: HomeBlock[]; errors: string[] }> {
  const [a, b] = await Promise.all([
    settle(homeBlocksOf('s1', page, true), [] as HomeBlock[]),
    settle(homeBlocksOf('s2', page, true), [] as HomeBlock[]),
  ]);

  const blocks: HomeBlock[] = [...a.value, ...b.value];

  const errors: string[] = [];
  if (a.error) errors.push(`${SOURCE_LABEL.s1}：${a.error}`);
  if (b.error) errors.push(`${SOURCE_LABEL.s2}：${b.error}`);

  return { blocks, errors };
}

/**
 * 聚合搜索：两源并发，**结果都保留**。
 *
 * ★★ 这里**故意不做跨源去重**（用户实测反馈 2026-10-16）。
 *
 *   曾经按标题去重：同一部剧两个源都有时只留全网源那条。看着合理，
 *   实际会把源2 的搜索结果**整条吞掉**：
 *     - 源1 的搜索很"松" —— 搜「背着善宰跑」回 23 条近似标题
 *       （背着你跳舞 / 背着奶奶进城 / 善刃 …）；
 *     - 源2 的结果本来就只有 1–3 条，且标题必然和源1 撞。
 *   于是一搜韩剧中文名，界面上一条【精选源】都看不到 —— 用户的原话是
 *   "源2 的搜索没有出结果，明明是有的"。
 *
 *   现在两源各出各的：同一部剧会出现两张卡（一张【全网源】、一张【精选源】），
 *   靠卡片左上角**按源配色的角标**区分（见 components/MediaCard.tsx）。
 */
export async function searchAll(keyword: string): Promise<{ items: VodItem[]; errors: string[] }> {
  const [a, b] = await Promise.all([
    settle(s1.search(keyword), [] as VodItem[]),
    settle(s2.search(keyword), [] as VodItem[]),
  ]);

  // 只挡掉空标题（两个源的 DTO 理论上都保证非空，这里兜一道）
  const items: VodItem[] = [...a.value, ...b.value].filter((x) => x.title.trim());

  const errors: string[] = [];
  if (a.error) errors.push(`全网源：${a.error}`);
  if (b.error) errors.push(`精选源：${b.error}`);

  return { items, errors };
}

export interface CategoryOption {
  label: string;
  value: string | number;
}

/** 一个筛选维度：一行可选项 */
export interface FilterRow {
  title: string;
  options: Array<{ label: string; value: string }>;
}

/** 分类页的筛选条件。两个源的字段不一样，用一份并集表达 */
export interface CategoryQuery {
  page?: number;
  // 源1
  typeId?: number;
  typeValue?: string;
  tagType?: string;
  area?: string;
  // 源2
  stype?: number | null;
  cid?: number | null;
  // 公共
  year?: string;
  sort?: string;
}

/** 分类列表（按 sourceId 路由到对应源） */
export async function listByCategory(
  sourceId: SourceId,
  params: CategoryQuery,
): Promise<VodItem[]> {
  return sourceId === 's1' ? s1.listByCategory(params) : s2.listByCategory(params);
}

/**
 * 分类树（按 sourceId 路由）。
 *
 * ★ 两边的形态差得很远，**不硬抹平成一套** ——
 *   源1 是「分类 -> 每个分类各有自己的筛选维度」，源2 是「三组大类 + 各自的细分」。
 *   各自原样返回，由分类页按源分别渲染。
 */
export const s1CategoryTree = s1.categoryTree;
export const s1FilterRowsFor = s1.filterRowsFor;
export const s2CategoryTree = s2.categoryTree;

/** 详情（按 sourceId 路由） */
export async function detail(sourceId: SourceId, id: string): Promise<VodDetail> {
  return sourceId === 's1' ? s1.detail(id) : s2.detail(id);
}

/** 热搜词（只有源 1 提供） */
export const hotSearch = s1.hotSearch;

/** 明星专区（源 2 专属） */
export const stars = s2.stars;
export const starWorks = s2.starWorks;

export { s1, s2 };
