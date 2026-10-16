/**
 * 源 2 的高层门面。
 *
 * 设备号从本地存储取（**必须持久化**：上游按设备号钉死 CDN 节点），
 * 播放地址解析走 GOOD_UIDS 换号重试。
 */
import { episodeTitle } from '../../utils/episode';
import { getDeviceUid, notePlayNode } from '../../utils/storage';
import { Source2Client, playWithFallback, seriesBrief } from './client';
import type { Episode, VodDetail, VodItem } from '../../types/schema';

let cachedUid: string | null = null;

async function deviceUid(): Promise<string> {
  if (!cachedUid) cachedUid = await getDeviceUid();
  return cachedUid;
}

/** 用**持久化设备号**建客户端（randomUid=false，保证节点稳定） */
export async function makeClient(): Promise<Source2Client> {
  return new Source2Client(await deviceUid(), null, false);
}

export interface HomeBlock {
  title: string;
  items: VodItem[];
}

/** 首页推荐 */
export async function homeFeed(page = 1): Promise<HomeBlock[]> {
  const client = await makeClient();
  return client.recommendBlocks(page);
}

/** 分类筛选 */
export async function listByCategory(params: {
  stype?: number | null;
  cid?: number | null;
  year?: string | null;
  sort?: string | null;
  page?: number;
}): Promise<VodItem[]> {
  const client = await makeClient();
  const page = await client.catePage(params);
  return page.items;
}

/** 一个筛选维度：一行可选项 */
export interface FilterRow {
  title: string;
  options: Array<{ label: string; value: string }>;
}

/**
 * 分类树。
 *
 * ★ 源2 与源1 完全不同：它一次请求就把筛选项和剧集一起返回
 *   （`catePage` 空参调用即可），分三组 韩剧/综艺/电影，每组下面才是细分。
 *   所以这边不做「按分类存维度」，直接摊平成几行。
 */
export interface CategoryTree {
  groups: Array<{ label: string; value: number; cates: Array<{ label: string; value: string }> }>;
  sorts: Array<{ label: string; value: string }>;
  years: Array<{ label: string; value: string }>;
}

const toOptions = (rows: Array<Record<string, unknown>>): Array<{ label: string; value: string }> =>
  rows
    .map((o) => ({ label: String(o.name ?? ''), value: String(o.value ?? '') }))
    .filter((o) => o.label);

export async function categoryTree(): Promise<CategoryTree> {
  const client = await makeClient();
  const page = await client.catePage({});

  const groups = (page.groups as Array<Record<string, unknown>>).map((g) => ({
    label: String(g.name ?? ''),
    value: Number(g.stype ?? 0),
    cates: toOptions((g.cates as Array<Record<string, unknown>>) ?? []),
  }));

  return { groups, sorts: toOptions(page.sorts as Array<Record<string, unknown>>), years: toOptions(page.years as Array<Record<string, unknown>>) };
}

/** 搜索 */
export async function search(keyword: string): Promise<VodItem[]> {
  const client = await makeClient();
  const result = await client.searchPage(keyword);
  return result.items;
}

/** 详情 */
export async function detail(sid: string): Promise<VodDetail> {
  const client = await makeClient();
  const d = await client.detailPage(sid.replace(/^s2_/, ''));

  const episodes: Episode[] = (d.episodes as Array<Record<string, unknown>>).map((it, index) => ({
    episodeIndex: index,
    title: episodeTitle(it.title, index),
    pid: String(it.pid ?? ''),
    duration: String(it.duration ?? ''),
    durationSec: 0,
  }));

  return {
    vodId: String(d.sid ?? sid),
    sourceId: 's2',
    name: String(d.name ?? ''),
    pic: String(d.thumb ?? ''),
    actor: String(d.crew ?? ''),
    director: '',
    year: '',
    area: '',
    blurb: String(d.intro ?? ''),
    episodes,
    // ★ 上游的档位名会重名（两个都叫「蓝光」），分辨率才是区分它们的那个 ——
    //   实测：蓝光 HDR(11) / 蓝光 1080P(10) / 高清 720P(2) / 标清 480P(1)
    //
    // ★★ 但**会员档位要藏掉**：实测（2026-10-15）手里没有账号时，
    //   请求蓝光档（sq=10 / 11）上游会**静默降级到最差的标清 480P** ——
    //   比不请求还差（不传 sq 反而给高清 720P）。摆出来只会让人误点。
    //   `vtype: 1` 就是会员档位的标记（两个蓝光都是 1，高清/标清都是 0）。
    qualities: (() => {
      const raw = (d.qualities as Array<Record<string, unknown>>) ?? [];
      const free = raw.filter((q) => Number(q.vtype ?? 0) !== 1);
      // 万一整部剧都被判成会员档，至少别把列表清空
      return (free.length ? free : raw).map((q) => ({
        label: [String(q.name ?? ''), String(q.resolution ?? '')].filter(Boolean).join(' '),
        value: Number(q.value ?? 0),
      })).filter((q) => q.label);
    })(),
    // ★ 季列表原样传上去（单季的剧上游只给 0~1 项，由 UI 决定要不要显示切换条）。
    //   每一季是**独立的 sid**：切季就是换个 sid 重新拉详情，详见 client.detailPage。
    seasons: (d.seasons as Array<{ sid: string; title: string }> | undefined) ?? [],
  };
}

/** 明星列表 */
export async function stars(): Promise<{
  hot: Array<Record<string, unknown>>;
  pop: Array<Record<string, unknown>>;
}> {
  const client = await makeClient();
  return client.stars();
}

/** 明星作品集 */
export async function starWorks(sid: number): Promise<{ groups: Array<Record<string, unknown>> }> {
  const client = await makeClient();
  return client.starWorks(sid);
}

/**
 * 取某一集的播放地址（含 GOOD_UIDS 换号重试）。
 *
 * ★ 返回值是**这一集的分段列表**：一集可能被切成十几段 mp4，要按顺序连着播。
 *   `options.quality` 才是清晰度（走 `sq` 参数），别跟分段搞混。
 */
export async function playFor(
  sid: string,
  episode: Episode,
  options: { quality?: number | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const client = await makeClient();
  return playWithFallback(
    client,
    sid.replace(/^s2_/, ''),
    episode.pid ?? '',
    null,
    { sq: options.quality ?? null },
    // ★ 用持久化设备号这一枪分到 http（piccc 慢节点）就记一笔；
    //   连着几次都慢的话，**下次启动**会换一个新设备号重新随机分节点
    (hasHttps) => void notePlayNode(hasHttps),
  );
}

export { seriesBrief };
