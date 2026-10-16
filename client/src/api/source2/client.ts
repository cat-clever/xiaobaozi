/**
 * 源 2 的接口客户端。
 *
 * 与 `参考/影视站api2.js` 的 HanjuClient 一一对应。
 *
 * ★ 三个必须守住的点（都是实测踩出来的）：
 *   1. **设备号不只是身份，还是响应解密的密钥输入** —— 解密时必须用
 *      "发这次请求的那个设备号"，用错就解出乱码。所以每次响应都挂着
 *      `_uid`（不可枚举，不会漏进 JSON）。
 *   2. **搜索走 s4 不走 s5** —— s5 对没见过的设备号直接返回空，
 *      而随机设备号模式下每个请求都是新号。
 *   3. **解析播放地址时必须转发访客 IP** —— 上游按请求方 IP 挑 CDN 节点。
 */
import { NetworkError, ApiError } from '../errors';
import { httpRequest } from '../http';
import {
  APP,
  BASE,
  CH,
  DEFAULT_DEVICE_UID,
  GOOD_UIDS,
  GOOD_UID_TRIES,
  RAND_CHARS,
  SAID,
  SCENE_REWARD,
  UA,
  UID_RE,
  VC,
  VN,
  WORKS_CATE,
} from './constants';
import {
  aesD,
  decrypt,
  makeSign,
  makeSignHeader,
  makeUk,
  md5hex,
  randUid,
} from './crypto';
import { episodeTitle } from '../../utils/episode';
import type { VodItem } from '../../types/schema';

/** 上游响应，附带的 `_uid` 是"本次请求实际用的设备号" */
export type UpstreamResponse = Record<string, unknown> & { _uid?: string };

/** 带设备号的请求结果 */
function withUid(obj: UpstreamResponse, uid: string): UpstreamResponse {
  Object.defineProperty(obj, '_uid', { value: uid, enumerable: false });
  return obj;
}

const asArray = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>) : [];

/** 去掉 HTML 标签，详情正文里常带 */
export function stripHtml(s: unknown): string {
  return String(s ?? '').replace(/<[^>]*>/g, '').trim();
}

/**
 * 剧集卡片归一化。
 *
 * ★ 字段位置以实测为准（2026-10-15 实网探针，见仓库根目录《改动记录.md》）：
 *   封面在 **`image.thumb` / `image.poster`**，不在顶层；
 *   分类在 `relatedCateInfo.name`；简介在 `shorthand`；集数文案在 `conerMemo`。
 *   原来读 `s.thumb`（不存在）再回落到 `s.image`（一个对象），
 *   被 `String()` 变成 `"[object Object]"` —— 源2 的封面一直是白的。
 */
export function seriesBrief(s: Record<string, unknown>): VodItem {
  const image = (s.image ?? {}) as Record<string, unknown>;
  const cate = (s.relatedCateInfo ?? {}) as Record<string, unknown>;
  const published = Number(s.publishTime ?? 0);

  return {
    id: `s2_${String(s.sid ?? '')}`,
    sourceId: 's2',
    title: String(s.name ?? s.title ?? ''),
    coverUrl: String(image.thumb ?? image.poster ?? ''),
    rating: String(s.score ?? ''),
    category: String(cate.name ?? ''),
    // 上游只给发布时间戳，没有年份字段
    year: published > 0 ? String(new Date(published).getFullYear()) : String(s.year ?? ''),
    area: String(s.area ?? ''),
    remarks: String(s.conerMemo ?? s.detailMemo ?? s.memo ?? ''),
    intro: stripHtml(s.shorthand ?? s.intro),
  };
}

/** 明星卡片归一化 */
export function starBrief(s: Record<string, unknown>): Record<string, unknown> {
  return { sid: s.sid, name: String(s.name ?? ''), thumb: String(s.thumb ?? '') };
}

/** 筛选项归一化 */
const optionBrief = (o: Record<string, unknown>): Record<string, unknown> => ({
  name: String(o.name ?? ''),
  value: o.value,
});

export class Source2Client {
  readonly deviceUid: string;
  readonly randomUid: boolean;
  private readonly ukOverride: string | null;

  constructor(deviceUid?: string, uk?: string | null, randomUid = true) {
    this.deviceUid = deviceUid || DEFAULT_DEVICE_UID;
    this.ukOverride = uk ?? null;
    this.randomUid = randomUid;
  }

  /** 本次请求用哪个设备号。随机模式下每次现生成一个 20 位串 */
  pickUid(): string {
    return this.randomUid ? randUid(RAND_CHARS) : this.deviceUid;
  }

  udidOf(uid: string): string {
    return md5hex(uid);
  }

  get udid(): string {
    return this.udidOf(this.deviceUid);
  }

  /**
   * 构造请求头。
   *
   * ★ `uk` / `sign` 都由 uid 本地推导 —— **换设备号时这两个头必须跟着换**，
   *   漏了或配错就会拿到空壳响应。
   */
  headers(uid: string): Record<string, string> {
    return {
      vc: VC,
      vn: VN,
      ch: CH,
      app: APP,
      'User-Agent': UA,
      said: SAID,
      'auth-token': '',
      'auth-uid': '',
      sign: makeSignHeader(uid),
      uk: this.ukOverride || makeUk(uid),
    };
  }

  /** GET，响应挂 `_uid` */
  async get(
    path: string,
    params?: Record<string, unknown>,
    uid?: string,
  ): Promise<UpstreamResponse> {
    const u = uid || this.pickUid();
    const url = new URL(BASE + '/' + path.replace(/^\//, ''));
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const resp = await httpRequest(url.toString(), {
      headers: this.headers(u),
      timeoutMs: 15000,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new NetworkError('上游 HTTP ' + resp.status);
    }
    if (!resp.text) throw new ApiError('上游返回空（路径可能不存在）');

    let obj: UpstreamResponse;
    try {
      obj = JSON.parse(resp.text) as UpstreamResponse;
    } catch {
      throw new ApiError('上游返回的不是 JSON: ' + resp.text.slice(0, 200));
    }
    return withUid(obj, u);
  }

  /** POST（JSON body），响应挂 `_uid` */
  async post(
    path: string,
    payload: unknown,
    uid?: string,
  ): Promise<UpstreamResponse> {
    const u = uid || this.pickUid();
    const resp = await httpRequest(BASE + '/' + path.replace(/^\//, ''), {
      method: 'POST',
      headers: { ...this.headers(u), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new NetworkError('上游 HTTP ' + resp.status);
    }
    let obj: UpstreamResponse;
    try {
      obj = JSON.parse(resp.text) as UpstreamResponse;
    } catch {
      throw new ApiError('上游返回的不是 JSON: ' + resp.text.slice(0, 200));
    }
    return withUid(obj, u);
  }

  /**
   * 调接口并解开响应里加密的 `data`。
   *
   * ★ 用 `resp._uid` 解密 —— 必须是发这次请求的那个设备号。
   */
  async getDecrypted(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await this.get(path, params);
    const data = resp.data;
    if (typeof data === 'string' && data) {
      try {
        return JSON.parse(decrypt(data, resp._uid as string, (resp.ts as number) ?? null)) as Record<
          string,
          unknown
        >;
      } catch {
        return resp;
      }
    }
    return resp;
  }

  // ---------------- 业务接口 ----------------

  /** 首页推荐流，归一化成 [{title, items}] */
  async recommendBlocks(page = 1): Promise<Array<{ title: string; items: VodItem[] }>> {
    const d = await this.getDecrypted('api/index/recommend_v5', { page });
    const out: Array<{ title: string; items: VodItem[] }> = [];
    for (const blk of asArray(d.mediaBlocks)) {
      const items = asArray(blk.seriesList)
        .filter((s) => s.sid)
        .map(seriesBrief);
      if (items.length) out.push({ title: String(blk.title ?? ''), items });
    }
    return out;
  }

  /** 分类页：一次请求同时返回筛选项和该页剧集 */
  async catePage(o: {
    stype?: number | null;
    cid?: number | null;
    year?: string | null;
    sort?: string | null;
    page?: number;
  } = {}): Promise<{
    groups: Array<Record<string, unknown>>;
    sorts: Array<Record<string, unknown>>;
    years: Array<Record<string, unknown>>;
    items: VodItem[];
    more: unknown;
  }> {
    const p: Record<string, unknown> = { page: o.page ?? 1 };
    if (o.stype !== null && o.stype !== undefined) p.stype = o.stype;
    if (o.cid !== null && o.cid !== undefined) p.cid = o.cid; // -1 是"全部"，是有效值
    if (o.year) p.year = o.year;
    if (o.sort) p.sort = o.sort;

    const d = await this.getDecrypted('api/series2/arrange/cate', p);
    return {
      groups: asArray(d.groups).map((g) => ({
        stype: g.stype,
        name: String(g.name ?? ''),
        cates: asArray(g.cates).map(optionBrief),
      })),
      sorts: asArray(d.sorts).map(optionBrief),
      years: asArray(d.years).map(optionBrief),
      items: asArray(d.seriesList)
        .filter((x) => x.sid)
        .map(seriesBrief),
      more: d.more,
    };
  }

  /**
   * 搜索。
   *
   * ★ 用 **s4** 不是 s5：s5 结果更全，但对**没见过的设备号直接返回空**，
   *   而随机设备号模式下每个请求都是新号 —— 换 s5 会让搜索整个失效。
   */
  async searchPage(keyword: string, refer = 'search'): Promise<{ kw: string; items: VodItem[] }> {
    const d = await this.getDecrypted('api/search/s4', { k: keyword, srefer: refer });
    return {
      kw: keyword,
      items: asArray(d.seriesList)
        .filter((x) => x.sid)
        .map(seriesBrief),
    };
  }

  // ---------------- 详情 ----------------

  async detailNormal(sid: string): Promise<Record<string, unknown>> {
    return this.getDecrypted('api/series2/detail/normal', { sid });
  }

  /** 详情页要用的东西：剧集信息 + 选集 + 清晰度 + 相关推荐 */
  async detailPage(sid: string): Promise<Record<string, unknown>> {
    const d = await this.detailNormal(sid);
    const s = (d.series ?? {}) as Record<string, unknown>;
    const img = (s.image ?? {}) as Record<string, unknown>;

    const episodes = asArray(d.playItems)
      .filter((it) => it.pid)
      .map((it, index) => ({
        pid: it.pid,
        no: it.serialNo,
        title: episodeTitle(it.title, index),
        duration: String(it.duration ?? ''),
        locked: !allowPlay(it.permission),
        lockType: lockType(it.permission),
      }));

    const rec = ((d.recommends ?? {}) as Record<string, unknown>).items;

    return {
      sid: s.sid ?? sid,
      name: String(s.name ?? ''),
      thumb: String(img.thumb ?? img.poster ?? ''),
      intro: stripHtml(s.intro),
      crew: String(s.crew ?? ''),
      shorthand: String(s.shorthand ?? ''),
      memo: String(s.detailMemo ?? s.conerMemo ?? ''),
      cate: String(((s.relatedCateInfo ?? {}) as Record<string, unknown>).name ?? ''),
      schedule: String(s.updateSchedule ?? ''),
      hdr: s.hdr,
      qualities: s.scopeQualities ?? [],
      episodes,
      similar: asArray(rec)
        .filter((x) => x.sid)
        .map(seriesBrief),
      // 季列表：多季的剧这里才不止一项，每一季是**独立的 sid**
      seasons: asArray(d.buckets)
        .filter((b) => b.sid)
        .map((b) => ({ sid: b.sid, title: String(b.title ?? '') })),
    };
  }

  // ---------------- 明星 ----------------

  /** 明星列表（**明文**，不需要解密） */
  async stars(): Promise<{ hot: Array<Record<string, unknown>>; pop: Array<Record<string, unknown>> }> {
    const r = await this.get('star/api/star/hotStars');
    const s = (r.stars ?? {}) as Record<string, unknown>;
    return { hot: asArray(s.hotStars).map(starBrief), pop: asArray(s.popStars).map(starBrief) };
  }

  /** 按名字搜明星（明文；服务端要求至少两个字） */
  async starSearch(name: string): Promise<{ stars: Array<Record<string, unknown>> }> {
    const r = await this.get('star/api/star/search', { name });
    return { stars: asArray(r.stars).map(starBrief) };
  }

  /** 明星详情（明文） */
  async starDetail(sid: number): Promise<Record<string, unknown>> {
    const st = ((await this.get('star/api/star/info', { sid })).star ?? {}) as Record<string, unknown>;
    return {
      sid: st.sid,
      name: String(st.name ?? ''),
      thumb: String(st.thumb ?? ''),
      poster: String(st.poster ?? ''),
      fansCount: st.fansCount,
      fansRank: st.fansCountRank,
    };
  }

  /** 明星作品集，按分类分组（明文）。cate: 1=影视，3=综艺 */
  async starWorks(sid: number): Promise<{ groups: Array<Record<string, unknown>> }> {
    const info = await this.get('star/api/star/info', { sid });
    const cates = Array.isArray(info.workCates) ? (info.workCates as number[]) : [1];

    const groups: Array<Record<string, unknown>> = [];
    for (const cate of cates) {
      const r = await this.get('api/star/works', { sid, cate, offset: 0, count: 30 });
      const works = asArray(r.works)
        .filter((w) => w.sid)
        .map((w) => ({ sid: w.sid, title: String(w.title ?? ''), thumb: String(w.thumb ?? '') }));
      if (works.length) groups.push({ cate, name: WORKS_CATE[cate] ?? '作品', works });
    }
    return { groups };
  }

  // ---------------- 播放 ----------------

  async episodes(pid: string, refer = ''): Promise<Record<string, unknown>> {
    return this.getDecrypted('api/series2/episode/detail', { pid, refer });
  }

  /** 从 episode/detail 挑一个源，返回 {scid, src} */
  async pickSource(pid: string): Promise<{ scid: string | null; src: unknown }> {
    const d = await this.episodes(pid);
    const pi = (d.playItem ?? {}) as Record<string, unknown>;
    for (const s of asArray(pi.sources)) {
      if (s.scid) return { scid: String(s.scid), src: s.src };
    }
    return { scid: null, src: null };
  }

  /**
   * 解析播放地址的**密文**。
   *
   * ★ `udid` 只参与 sign 的计算，**不放 URL**（放了会 bad request params）。
   */
  async resolveV4(
    pid: string,
    scid: string | null,
    o: { uid?: string; resume?: number; st?: number | null; sq?: number | null; ttk?: string; bd?: number | null } = {},
  ): Promise<UpstreamResponse> {
    const t = String(Math.floor(Date.now() / 1000));
    // 先把这次的设备号定下来：它既要进 sign（udid），又要用于解密响应
    const uid = o.uid || this.pickUid();

    const kv: Record<string, string> = {
      t,
      dt: 'android',
      version: VN,
      uuid: randUid('0123456789abcdef') + randUid('0123456789abcdef'),
      udid: this.udidOf(uid), // ★ 只进 sign
      pid,
      scid: scid ?? '',
      re: String(o.resume === undefined ? 0 : o.resume),
    };
    if (o.st !== undefined && o.st !== null) kv.st = String(o.st);
    if (o.sq !== undefined && o.sq !== null) kv.sq = String(o.sq);
    if (o.ttk) kv.ttk = o.ttk;
    if (o.bd !== undefined && o.bd !== null) kv.bd = String(o.bd);

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(kv)) if (k !== 'udid') params[k] = v;
    params.sign = makeSign(kv);

    return this.get('api/series/rslvV4', params, uid);
  }

  /**
   * 101（看广告解锁）—— 换本集的一次性播放 token。
   *
   * 实测服务端**不校验广告有没有真播**：把它自己下发的 traceId 原样回传就给 token。
   * ★ token 既绑 pid 又绑设备号，所以调用方必须用**同一个 uid** 去重试。
   */
  async rewardToken(pid: string, scene = SCENE_REWARD, uid?: string): Promise<string | null> {
    const u = uid || this.pickUid();
    const r1 = await this.get('api/carp/reward/v2', { scene }, u);
    if (!r1.data) return null;

    const traceId = (
      JSON.parse(decrypt(r1.data as string, u, (r1.ts as number) ?? null)) as Record<string, unknown>
    ).traceId;
    if (!traceId) return null;

    const r2 = await this.post(
      'api/carp/reward/rp/v2',
      { data: aesD(JSON.stringify({ pid, scene, traceId }), u) },
      u,
    );
    if (!r2.data) return null;

    const info = JSON.parse(decrypt(r2.data as string, u, (r2.ts as number) ?? null)) as Record<
      string,
      unknown
    >;
    return ((info.rewardTokenInfo ?? {}) as Record<string, unknown>).token as string | null ?? null;
  }

  /** 一步拿到可播放地址：找源 -> rslvV4 -> 解密 */
  async playUrl(
    pid: string,
    scid: string | null,
    o: { uid?: string; resume?: number; st?: number | null; sq?: number | null; ttk?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    let source = scid;
    let src: unknown = null;
    if (!source) {
      const p = await this.pickSource(pid);
      source = p.scid;
      src = p.src;
    }
    if (!source) return [];

    let resp = await this.resolveV4(pid, source, o);

    // 101（看广告解锁）自动处理：回 10401 就换 ttk 再试一次。
    // ★ ttk 绑设备号，解锁和重试必须用**同一个 uid**。
    if (Number(resp.rescode) === 10401 && !o.ttk) {
      const uid = this.pickUid();
      const ttk = await this.rewardToken(pid, SCENE_REWARD, uid);
      if (ttk) resp = await this.resolveV4(pid, source, { ...o, ttk, uid });
    }

    const out: Array<Record<string, unknown>> = [];
    for (const item of asArray(resp.datas)) {
      if (!item.data) continue;
      // ★ rslvV4 不带 ts；且必须用 resp._uid 解
      const info = JSON.parse(
        decrypt(item.data as string, resp._uid as string, null),
      ) as Record<string, unknown>;
      info.smid = item.smid;
      info.pid = pid;
      info.scid = source;
      info.quality = resp.quality;
      info.qualityName = resp.qualityName;
      if (src) info.src = src;
      out.push(info);
    }
    return out;
  }

  /** 给个 sid 走完整链路。`o.sq` 是清晰度档位 */
  async playBySid(
    sid: string,
    o: { uid?: string; resume?: number; st?: number | null; sq?: number | null; ttk?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const d = await this.detailNormal(sid);
    for (const pi of asArray(d.playItems)) {
      if (!pi.pid) continue;
      const items = await this.playUrl(String(pi.pid), null, o);
      if (items.length) return items;
    }
    return [];
  }
}

/** 这批播放地址里有没有 https 的。上游分到 piccc 节点给的就是 http */
export function hasHttpsPlay(items: Array<Record<string, unknown>>): boolean {
  return items.some((it) => /^https:\/\//i.test(String(it.playUrl ?? '')));
}

/** 从 GOOD_UIDS 里无放回随机抽 n 个（保证不重复） */
export function sampleUids(n: number, exclude?: string): string[] {
  const pool = GOOD_UIDS.filter((u) => u !== exclude);
  const out: string[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/**
 * 解一次播放地址；拿到 http（piccc 节点）就换内置的已知好号重试。
 *
 * ★ 返回的是**这一集的分段列表**，不是清晰度列表 —— 一集可能被切成十几段 mp4
 *   （实测「OK老板娘」就是），必须按顺序连着播。清晰度用 `options.sq` 选。
 *
 * ★ 兜底很重要：上游这几秒会抖 —— 同一个号连问两次可能一次给数据、一次回空。
 *   所以重试过程中**只要有号拿回数据就先兜住**，哪怕它是 http 节点
 *   （http 分片经本地媒体服务一样能播）。
 */
export async function playWithFallback(
  client: Source2Client,
  sid: string | null,
  pid: string,
  scid: string | null,
  options: { sq?: number | null } = {},
  /**
   * 第一枪（用**持久化设备号**那次）的结果回调。
   *
   * 用来判断这个设备号是不是被钉在了慢节点上 —— 后面换 `GOOD_UIDS` 重试
   * 成功了不代表设备号本身是好的，所以必须看第一枪。
   */
  onFirstAttempt?: (hasHttps: boolean) => void,
): Promise<Array<Record<string, unknown>>> {
  const once = (c: Source2Client): Promise<Array<Record<string, unknown>>> =>
    sid ? c.playBySid(sid, options) : c.playUrl(pid, scid, options);

  const items = await once(client);
  // ★ 只在**真的拿到数据**时才判定 —— 空结果是上游抖动，跟节点无关
  if (items.length) onFirstAttempt?.(hasHttpsPlay(items));
  if (hasHttpsPlay(items)) return items;

  let best: Array<Record<string, unknown>> | null = items.length ? items : null;

  for (const uid of sampleUids(GOOD_UID_TRIES, client.deviceUid)) {
    const alt = new Source2Client(uid, null, false);
    const t = await once(alt);
    if (hasHttpsPlay(t)) return t;
    if (!best && t.length) best = t;
  }
  return best ?? items;
}

/** 判断设备号格式是否合法 */
export const isValidUid = (uid: string): boolean => UID_RE.test(uid);

/**
 * 取出权限码。
 *
 * ★ 上游给的是**对象** `{type: 101}` 而不是裸数字 ——
 *   直接 `Number(permission)` 会得到 NaN（"不受限"），把受限集误判成能播。
 */
export function permissionCode(permission: unknown): number {
  const raw =
    permission && typeof permission === 'object'
      ? (permission as Record<string, unknown>).type
      : permission;
  const p = Number(raw ?? 0);
  return Number.isNaN(p) ? 0 : p;
}

/** 权限判定：能不能直接播 */
export function allowPlay(permission: unknown): boolean {
  const p = permissionCode(permission);
  return p === 0 || p === 1;
}

/** 受限类型：101 看广告 / 102 会员 / 103 付费 */
export function lockType(permission: unknown): number {
  return permissionCode(permission);
}
