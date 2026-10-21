/**
 * 源 1 的高层门面。
 *
 * 把"客户端 + 降级链 + 线路组装"包成一个好用的接口，
 * 让 UI 层不必关心马甲、域名兜底这些细节。
 */
import { AllDownError, ApiError } from '../errors';
import { Source1Client } from './client';
import { ALL_DOWN_HINT, AUTO_CHAIN, IMAGE_BASE, MAHAO } from './constants';
import type { MahaoId } from './constants';
import { episodes, mergeDurations, playLines } from './play';
import type { Episode, PlayLine, VodDetail, VodItem } from '../../types/schema';

/**
 * 把上游给的封面地址补成绝对地址。
 *
 * ★ `collection_list_v2` 回的是相对路径（`upload/vod/...`），
 *   `recommend_v2` / `screen_v2` 回的是绝对地址 —— 两种形态都要能过。
 */
export function absolutePic(raw: unknown): string {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return IMAGE_BASE + url.replace(/^\/+/, '');
}

/** 把上游条目归一化成统一 DTO */
export function toVodItem(raw: Record<string, unknown>): VodItem {
  // 字段名以实测为准（2026-10-15 真机 + 本地实网核对）：
  //   评分是 vod_douban_score、分类是 vod_tag、简介是 vod_blurb
  return {
    id: `s1_${String(raw.id ?? '')}`,
    sourceId: 's1',
    title: String(raw.vod_name ?? ''),
    coverUrl: absolutePic(raw.vod_pic),
    rating: String(raw.vod_douban_score ?? ''),
    category: String(raw.vod_tag ?? ''),
    year: String(raw.vod_year ?? ''),
    area: String(raw.vod_area ?? ''),
    remarks: String(raw.remarks ?? ''),
    intro: String(raw.vod_blurb ?? ''),
  };
}

/**
 * 从自动降级链里挑第一个**能用**的马甲。
 *
 * 全挂时抛 AllDownError，附带每一家的失败原因 —— UI 好单独提示。
 */
async function pickClient(): Promise<Source1Client> {
  const errors: string[] = [];
  for (const mahao of AUTO_CHAIN) {
    const client = new Source1Client(mahao);
    try {
      await client.init();
      return client;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`${client.entry.label}: ${reason}`);
    }
  }
  throw new AllDownError(`${ALL_DOWN_HINT}（${errors.join('；')}）`);
}

/** 常驻客户端，避免每次请求都重新 init */
let shared: Promise<Source1Client> | null = null;

function getClient(): Promise<Source1Client> {
  if (!shared) {
    shared = pickClient().catch((err) => {
      shared = null; // 失败就清掉，让下次重试
      throw err;
    });
  }
  return shared;
}

/**
 * 播放专用的马甲链。
 *
 * ★ 叠影排最前：它是默认马甲，游客**不限额**，每集新开一个游客最稳。
 *   彩虹两个代次同理。天际排最后 —— 它吃一个内置老账号，留着当兜底，
 *   平时不消耗它。
 *
 * 链上每个马甲都试到"能取到线路"为止，前一个拿不到就自动往下走。
 */
const PLAY_CHAIN: MahaoId[] = [MAHAO.DIEYING, MAHAO.CHSP, MAHAO.CHSP_OLD, MAHAO.TIANJI];

/**
 * 取本集的 bean（含 `vod_token` / `cur_time`）。
 *
 * 优先 `detail_v2` —— 只有它能签发 token；拿不到再退 `collection_list_v2`，
 * 那边至少有选集元数据（游客身份走的就是这条）。
 */
async function episodeBeanFor(
  client: Source1Client,
  vodId: number,
  episode: Episode,
): Promise<Record<string, unknown> | null> {
  const wanted = String(episode.episodeId ?? '');
  // 没有 episodeId（老数据）就退回按下标取
  const pick = (list: Array<Record<string, unknown>>): Record<string, unknown> | null =>
    wanted ? list.find((b) => String(b.id ?? '') === wanted) ?? null : list[episode.episodeIndex] ?? null;

  let bean: Record<string, unknown> | null = null;
  try {
    bean = pick(episodes(await client.detail(vodId)));
  } catch {
    // detail 挂了不影响后面
  }
  if (bean && String(bean.vod_token ?? '')) return bean;

  try {
    const alt = pick(episodes(await client.collectionList(vodId)));
    if (alt) {
      // 以 detail 那份为准，缺的字段从 collection_list 补
      bean = {
        ...alt,
        vod_token: String(bean?.vod_token ?? alt.vod_token ?? ''),
        cur_time: String(bean?.cur_time ?? alt.cur_time ?? ''),
      };
    }
  } catch {
    // 两边都拿不到就返回已有的
  }
  return bean;
}

export interface HomeBlock {
  title: string;
  items: VodItem[];
}

/** 首页推荐 */
export async function homeFeed(page = 1): Promise<HomeBlock[]> {
  const client = await getClient();
  // ★★ 首页数据源用 `screen_v2`（`/api/new_search/screen_v2`），**不是**
  //   `recommend_v2`（2026-10-21 用户要求）。
  //
  //   参考实现 `参考/影视站api1.js` 的首页列表走的是 `/api/list` ->
  //   `screen(pn, type_id=0, 其余全空)`，也就是源站自己的默认排序列表；
  //   `recommend_v2` 是另一套推荐位，内容和首页列表对不上。
  //
  //   `client.screen` 的默认值正好就是参考实现那套参数（typeId=0、
  //   typeValue/tagType/area/year/sort 全空串），所以这里只传页码。
  const list = await client.screen({ pn: page });
  const items = list.map(toVodItem).filter((x) => x.title);
  return items.length ? [{ title: '热播推荐', items }] : [];
}

/** 分类筛选 */
export async function listByCategory(params: {
  typeId?: number;
  /** 题材名（接口的 `type_value`）。空串 = 全部 */
  typeValue?: string;
  /** 二级标签。接口把它按题材下标排成二维数组，只有选了题材才有对应的一组 */
  tagType?: string;
  area?: string;
  year?: string;
  sort?: string;
  page?: number;
}): Promise<VodItem[]> {
  const client = await getClient();
  const list = await client.screen({
    pn: params.page ?? 1,
    typeId: params.typeId ?? 0,
    typeValue: params.typeValue ?? '',
    tagType: params.tagType ?? '',
    area: params.area ?? '',
    year: params.year ?? '',
    sort: params.sort ?? '',
  });
  return list.map(toVodItem).filter((x) => x.title);
}

/** 一个筛选维度：一行可选项 */
export interface FilterRow {
  title: string;
  options: Array<{ label: string; value: string }>;
}

/**
 * 分类树。
 *
 * ★ 接口把每个分类的筛选维度塞在它自己的 `msg` 里，而且**选项是按分类不同的**：
 *   连续剧有 27 个题材、电影只有 32 个但排序值不一样。
 *   二级标签 `tag_type` 更是按**题材下标**排成二维数组，只有选了题材才有对应一组。
 *   所以这里按 type_id 存一份，UI 换分类时整组换掉。
 */
export interface CategoryTree {
  categories: Array<{ label: string; value: number }>;
  dims: Record<string, {
    type: string[];
    tagType: string[][];
    area: string[];
    year: string[];
    sort: string[];
  }>;
}

/** 选项里的「全部」「排序」表示不筛选 —— 与参考实现一致，内部统一成空串 */
const NONE_LABELS = new Set(['全部', '排序']);

const toOptions = (values: string[]): Array<{ label: string; value: string }> =>
  values
    .filter((v) => typeof v === 'string' && v)
    .map((v) => ({ label: v, value: NONE_LABELS.has(v) ? '' : v }));

export async function categoryTree(): Promise<CategoryTree> {
  const client = await getClient();
  const list = await client.types();

  const categories: Array<{ label: string; value: number }> = [];
  const dims: CategoryTree['dims'] = {};

  for (const item of list) {
    const id = Number(item.id ?? item.type_id ?? 0);
    if (!id) continue;
    categories.push({ label: String(item.name ?? item.type_name ?? `分类${id}`), value: id });

    const raw: Record<string, string[]> = {};
    for (const msg of asRecords(item.msg)) {
      const name = String(msg.name ?? '');
      const data = msg.data;
      if (name && Array.isArray(data)) raw[name] = data as string[];
    }

    dims[String(id)] = {
      type: raw.type ?? [],
      tagType: (raw.tag_type ?? []) as unknown as string[][],
      area: raw.area ?? [],
      year: raw.year ?? [],
      sort: raw.sort ?? [],
    };
  }

  return { categories, dims };
}

/** 把一棵分类树的某个分类摊成 UI 直接能画的行 */
export function filterRowsFor(tree: CategoryTree, typeId: number, genre: string): FilterRow[] {
  const dim = tree.dims[String(typeId)];
  if (!dim) return [];

  const rows: FilterRow[] = [];
  const push = (title: string, values: string[]): void => {
    const options = toOptions(values);
    if (options.length) rows.push({ title, options });
  };

  push('题材', dim.type);
  push('地区', dim.area);
  push('年份', dim.year);
  push('排序', dim.sort);

  // 二级标签：题材下标对应一组，没选题材就没有
  const genreIndex = dim.type.indexOf(genre);
  if (genreIndex >= 0 && Array.isArray(dim.tagType[genreIndex])) {
    push('标签', dim.tagType[genreIndex]);
  }
  return rows;
}

/** `item.msg` 这种「对象数组」的小工具 */
function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

/** 搜索 */
export async function search(keyword: string, page = 1): Promise<VodItem[]> {
  const client = await getClient();
  const list = await client.search(keyword, page);
  return list.map(toVodItem).filter((x) => x.title);
}

/** 热搜词 */
export async function hotSearch(): Promise<string[]> {
  try {
    const client = await getClient();
    const list = await client.hotSearch();
    return list.map((x) => String(x.name ?? x.word ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 详情。
 *
 * ★ 时长必须从 collection_list 取 —— result_v2 每集回的 duration 是假的
 *   （同一部剧所有集都是 0:0:19）。
 */
export async function detail(vodId: string): Promise<VodDetail> {
  const client = await getClient();
  const idNum = Number(vodId.replace(/^s1_/, ''));

  let raw = await client.detail(idNum);
  let collection: Record<string, unknown> = {};
  try {
    collection = await client.collectionList(idNum);
  } catch {
    // 拿不到就退回详情里的值，不影响播放
  }

  // 兜底：detail_v2 偶发回空对象时（例如被上游挡了），回落到 collection_list ——
  // 它带着完整数据（剧名/封面/选集都在），只是不带 vod_token，详情够用。
  // ★ 注意：这不是常态。常态下 detail_v2 是有数据的，前提是
  //   `init_v2` 下发的那个 token 被存下来带进了请求头（见 client.ts applyInit）。
  if (Object.keys(raw).length === 0 && Object.keys(collection).length > 0) {
    raw = collection;
  }

  // 时长以 collection_list 的为准：detail 回的 duration 是假的
  const eps: Episode[] = mergeDurations(episodes(raw), episodes(collection));

  return {
    vodId: String(idNum),
    sourceId: 's1',
    name: String(raw.vod_name ?? ''),
    pic: absolutePic(raw.vod_pic ?? raw.coverUrl),
    actor: String(raw.vod_actor ?? ''),
    director: String(raw.vod_director ?? ''),
    year: String(raw.vod_year ?? ''),
    area: String(raw.vod_area ?? ''),
    blurb: String(raw.vod_blurb ?? ''),
    episodes: eps,
  };
}

/**
 * 取某一集的线路表。
 *
 * 两件事必须由**同一个账号**完成，否则上游回空 bean（看着成功其实没数据）：
 *   `detail_v2` 签发 `vod_token` → `collection_v2` 拿线路。
 *
 * ★ 另外，`collection_v2` 的 `collection_id` 要的是**上游选集 id**
 *   （`episode.episodeId`），不是数组下标 —— 原实现传的是下标。
 */
export async function playLinesFor(
  vodId: string,
  episode: Episode,
): Promise<PlayLine[]> {
  const idNum = Number(vodId.replace(/^s1_/, ''));
  const collectionId = Number(episode.episodeId ?? '');
  const errors: string[] = [];

  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    throw new ApiError('这一集没有拿到上游选集 id，无法取线路（详情需要重新加载）');
  }

  for (const mahao of PLAY_CHAIN) {
    const client = new Source1Client(mahao);
    try {
      await client.init();

      const bean = await episodeBeanFor(client, idNum, episode);
      const token = String(bean?.vod_token ?? '');
      if (!bean || !token) {
        errors.push(`${client.entry.label}：这个身份签不出 vod_token`);
        continue;
      }

      const lines = playLines(
        await client.collection(idNum, collectionId, token, String(bean.cur_time ?? '')),
        client.secDomain,
        client.wsKey,
      );
      if (lines.length) return lines;
      errors.push(`${client.entry.label}：上游没回线路`);
    } catch (err) {
      errors.push(`${client.entry.label}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ★ 这里失败基本只有一个原因：没有马甲能签发 vod_token（见改动记录 1）
  throw new AllDownError(`取不到线路：${errors.join('；')}`);
}

/** 官方线路要先过第三方解析 */
export async function resolveOfficialLine(line: PlayLine): Promise<string> {
  if (!line.parsePrefix) throw new ApiError('这条官方线路没带解析服务');
  const client = await getClient();
  return client.resolve(line.parsePrefix, line.url);
}
