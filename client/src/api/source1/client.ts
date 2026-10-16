/**
 * 源 1 的接口客户端。
 *
 * 与 `参考/影视站api1.js` 的 TianjiClient 一一对应。
 *
 * 关键设计：
 *   - 身份在**构造时定下来**，不跟着全局走 —— 自动降级会切马甲，
 *     不能让在飞的请求半路换掉 app_id / 密钥
 *   - 域名有兜底池，引导域名被污染时能自动迁移
 *   - 游客不限额的马甲每次新开游客；只有天际吃常驻老账号
 *
 * ★ **游客也有身份**：`init_v2` 会给游客下发一个 token，必须存下来带进后续请求头
 *   （见 `applyInit`）。不存的话 detail_v2 / collection_v2 一律回 `result: {}`，
 *   看着成功其实没数据 —— 表现就是"线路一条都取不到"。
 */
import { NetworkError, ServerBusyError, ApiError } from '../errors';
import { sleep, httpRequest } from '../http';
import {
  API_PATHS,
  API_TIMEOUT_MS,
  DEFAULT_BASE,
  FALLBACK_BASES,
  MAHAO,
  MAHAO_TABLE,
  RETRIES,
  RETRY_SLEEP_MS,
  SEC_DOMAIN_FALLBACK,
  TIANJI_DEVICE_ID,
  TIANJI_TOKEN,
} from './constants';
import type { MahaoEntry, MahaoId } from './constants';
import { buildHeaders, decodeBody, unwrap } from './crypto';

/** 16 位小写 hex 的设备号 */
export function randomDeviceId(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return out;
}

/** 把上游返回的列表字段过滤成对象数组 */
function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

/**
 * 应用 init 下发的账号信息。
 *
 * ★★ 这里藏着源1 最容易踩的一个坑：**`init_v2` 会给游客也下发一个 token**，
 *   必须存下来带到后续请求头里。不存的话 `detail_v2` / `collection_v2`
 *   一律回 `result: {}` —— **不报错、看着成功**，表现就是"线路一条都取不到"。
 *
 *   对应参考实现的 `applyUserInfo()`（`参考/影视站api1.js:721`）：
 *       // 不存这个 token 的话，详情和播放接口都会返回 result:{}
 *       const token = String(info.token || "").trim();
 *       if (token) this.token = token;
 *
 *   天际那种带老账号的马甲也是在这里换新 token（uid 不变，token 每次换新）。
 *
 * 单独抽出来是为了能被单测覆盖 —— 这条静默失败过一次，代价是排查了一整轮。
 */
export function applyUserInfo(client: Source1Client, info: unknown): void {
  if (!info || typeof info !== 'object') return;
  const record = info as Record<string, unknown>;
  client.account = record;

  const issued = String(record.token ?? '').trim();
  // 没下发就保留原值 —— 天际构造时带的那个 token 不能因为一次空响应被清掉
  if (issued) client.token = issued;
}

/** 退避时长：3s 起，最多 6s */
const retrySleep = (): number =>
  RETRY_SLEEP_MS[0] + Math.random() * (RETRY_SLEEP_MS[1] - RETRY_SLEEP_MS[0]);

/** 域名记忆：上次跑通的域名优先，省掉每次从挂掉的引导域名重试 */
let memoBaseUrl = '';

export class Source1Client {
  readonly mahao: MahaoId;
  readonly entry: MahaoEntry;
  readonly wsKey: string;
  deviceId: string;
  token: string;
  baseUrl: string;
  account: Record<string, unknown> = {};
  sysConf: Record<string, unknown> = {};
  p2pConf: Record<string, unknown> = {};
  secDomain: string = SEC_DOMAIN_FALLBACK;

  constructor(mahao: MahaoId) {
    this.mahao = mahao;
    this.entry = MAHAO_TABLE[mahao];
    this.wsKey = this.entry.wsKey;
    this.baseUrl = (memoBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');

    // 只有天际那个马甲吃老账号；叠影/彩虹一律当新游客
    if (mahao === MAHAO.TIANJI) {
      this.deviceId = TIANJI_DEVICE_ID || randomDeviceId();
      this.token = TIANJI_TOKEN || '';
    } else {
      this.deviceId = randomDeviceId();
      this.token = '';
    }
  }

  /** 按**这个客户端**的接口代次取路径 */
  api(key: string): string {
    return API_PATHS[this.entry.api][key];
  }

  /** 候选域名：当前域名优先，然后是引导域名与兜底池 */
  candidates(): string[] {
    const out = [this.baseUrl];
    for (const base of [DEFAULT_BASE, ...FALLBACK_BASES]) {
      const trimmed = base.replace(/\/+$/, '');
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  /**
   * 发一次表单请求。
   *
   * 上游对突发请求敏感：连发几次会被挡，停一会儿又能通。
   * 所以重试次数少（RETRIES=2）、间隔长（3s / 6s）。
   */
  async post(
    path: string,
    params: Record<string, unknown> = {},
    baseUrl?: string | null,
  ): Promise<Record<string, unknown>> {
    const root = (baseUrl || this.baseUrl).replace(/\/+$/, '');
    const url = root + path;

    const body = Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');

    let last = '';
    let busy = 0;

    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const headers: Record<string, string> = {
        ...buildHeaders(this.entry, this.deviceId, this.token, Date.now()),
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      let text: string;
      try {
        const resp = await httpRequest(url, {
          method: 'POST',
          headers,
          body,
          timeoutMs: API_TIMEOUT_MS,
        });
        text = resp.text;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        // ★ 只有**还有下一次尝试**才退避 —— 最后一次失败后再睡 3~6 秒纯属白等
        if (attempt < RETRIES - 1) await sleep(retrySleep());
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = decodeBody(text);
      } catch (err) {
        if (err instanceof ServerBusyError) {
          busy += 1;
          last = '服务端返回错误提示：' + err.message;
        } else {
          last = err instanceof Error ? err.message : String(err);
        }
        if (attempt < RETRIES - 1) await sleep(retrySleep());
        continue;
      }

      const code = Number(data.code);
      if (code !== 10000) {
        throw new ApiError(`接口返回 code=${code} message=${String(data.message ?? '')}`);
      }
      return data;
    }

    // 每次都拿到错误页，说明是被挡了，换域名也救不回来
    if (busy === RETRIES) throw new ServerBusyError(last);
    throw new ApiError(`请求失败（已重试 ${RETRIES} 次）: ${String(last).slice(0, 200)}`);
  }

  /** 启动配置。服务端通过 api_url2 下发真正要用的域名 */
  async init(): Promise<void> {
    const errors: string[] = [];
    for (const base of this.candidates()) {
      try {
        const payload = await this.post(
          this.api('init'),
          { invited_by: '', is_install: '0', ua: '0' },
          base,
        );
        this.applyInit(payload, base);
        return;
      } catch (err) {
        errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new NetworkError('init 在所有候选域名上都失败：' + errors.join(' | '));
  }

  /** 应用 init 下发的配置：域名迁移、账号信息、p2p 配置 */
  private applyInit(payload: Record<string, unknown>, usedBase: string): void {
    this.baseUrl = usedBase;
    memoBaseUrl = usedBase;

    const result = (payload.result ?? payload.data ?? {}) as Record<string, unknown>;
    const apiConf = (result.api_conf ?? {}) as Record<string, unknown>;
    const nextUrl = String(apiConf.api_url2 ?? apiConf.api_url ?? '').trim();
    if (nextUrl.startsWith('http')) {
      this.baseUrl = nextUrl.replace(/\/+$/, '');
      memoBaseUrl = this.baseUrl;
    }

    applyUserInfo(this, result.user_info);
    this.sysConf = (result.sys_conf ?? {}) as Record<string, unknown>;

    const p2p = (this.sysConf.p2p_config ?? {}) as Record<string, unknown>;
    this.p2pConf = p2p;
    const secDomain = String(p2p.sec_domain ?? '').trim();
    if (secDomain) this.secDomain = secDomain;
    if (this.entry.secDomain) this.secDomain = this.entry.secDomain;
  }

  /** 带域名兜底的请求：当前域名挂了就换下一个 */
  async postWithFailover(
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const errors: string[] = [];
    for (const base of this.candidates()) {
      try {
        const result = await this.post(path, params, base);
        if (base !== this.baseUrl) {
          this.baseUrl = base;
          memoBaseUrl = base;
        }
        return result;
      } catch (err) {
        if (err instanceof ServerBusyError) throw err; // 被挡了，换域名也救不回来
        errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new NetworkError('所有候选域名都失败：' + errors.join(' | '));
  }

  // ---------------- 业务接口 ----------------

  private async call(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return unwrap(await this.postWithFailover(path, params));
  }

  async types(): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('types'), {}));
  }

  async channels(): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('channels'), {}));
  }

  async screen(params: {
    pn?: number;
    typeId?: number;
    typeValue?: string;
    tagType?: string;
    area?: string;
    year?: string;
    sort?: string;
  } = {}): Promise<Array<Record<string, unknown>>> {
    const {
      pn = 1,
      typeId = 0,
      typeValue = '',
      tagType = '',
      area = '',
      year = '',
      sort = '',
    } = params;
    return asRecords(
      await this.call(this.api('screen'), {
        pn,
        type_id: typeId,
        type_value: typeValue,
        tag_type: tagType,
        area,
        year,
        sort,
      }),
    );
  }

  async search(keyword: string, pn = 1): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('search'), { kw: keyword, pn }));
  }

  async recommend(pn = 1): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('recommend'), { pn }));
  }

  /** 详情。返回的 vod_collection 是选集数组 */
  async detail(vodId: number): Promise<Record<string, unknown>> {
    return this.call(this.api('detail'), { vod_id: vodId });
  }

  /** 取某一集的播放线路 */
  async collection(
    vodId: number,
    collectionId: number,
    vodToken: string,
    curTime: string,
  ): Promise<Record<string, unknown>> {
    return this.call(this.api('collection'), {
      vod_id: vodId,
      collection_id: collectionId,
      vod_token: vodToken,
      cur_time: curTime,
    });
  }

  /** 选集列表 —— 只有这里给的时长是真的 */
  /**
   * 选集时长。
   *
   * ★ 实测：这个接口回的是**一个对象**（内含 vod_collection 数组），
   *   不是数组本身 —— 用 asRecords 会把它过滤空。
   */
  async collectionList(vodId: number): Promise<Record<string, unknown>> {
    return this.call(this.api('collection_list'), { vod_id: vodId });
  }

  async hotSearch(): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('hot_search'), {}));
  }

  async suggest(keyword: string, pn = 1): Promise<Array<Record<string, unknown>>> {
    return asRecords(await this.call(this.api('suggest'), { kw: keyword, pn }));
  }

  /**
   * 官方线路要过第三方解析：`GET(解析前缀 + 线路地址)`。
   * 响应形如 `{"code": 200, "success": 1, "url": "真实播放地址"}`。
   */
  async resolve(prefix: string, target: string): Promise<string> {
    if (!prefix || !target) throw new ApiError('缺少解析前缀或线路地址');

    const resp = await httpRequest(prefix + target, {
      headers: buildHeaders(this.entry, this.deviceId, this.token, Date.now()),
      timeoutMs: API_TIMEOUT_MS,
    });

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(resp.text) as Record<string, unknown>;
    } catch {
      throw new ApiError('解析返回的不是 JSON: ' + resp.text.slice(0, 200));
    }
    if (Number(data.code) !== 200) {
      throw new ApiError(`解析失败 code=${String(data.code)} message=${String(data.message ?? '')}`);
    }
    const real = String(data.url ?? '').trim();
    if (!real) throw new ApiError('解析成功但没返回地址');
    return real;
  }
}
