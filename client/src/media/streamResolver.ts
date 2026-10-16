/**
 * 线路 -> 播放器可用地址。
 *
 * ★ v0.2.0 起，这里不再把上游地址直接交给播放器，而是统一换成
 *   **本地媒体服务**的地址（文档 §6.3）。原因是三条线路各有各的坎，
 *   只有把取流收进本地服务才解得开：
 *
 *   | 线路 | 坎 |
 *   | :--- | :--- |
 *   | 源1 主线路 | 分片必须**逐条现算 `wsSecret`**（30 秒时效），裸地址一律 403 |
 *   | 源2 全部 | m3u8 的分片不带播放列表的 query，CDN 会**限速到几乎不下发** |
 *   | 源1 镜像 / 官方 / m3u8 | 本身是直链，但请求头（`Mozi`）与 iOS 的明文限制要处理 |
 *
 *   播放器侧因此只认一个本地地址，不再需要任何自定义头能力。
 */
import { BADCI, MEDIA_UA } from '../api/source1/constants';
import * as s1 from '../api/source1';
import * as s2 from '../api/source2';
import { currentLanHost, openSession } from './mediaServer';
import type { MediaSessionConfig } from './mediaServer';
import { signRuleFor } from './segmentSigner';
import type { Episode, PlayLine, ResolvedMediaStream } from '../types/schema';

/** 源1 媒体请求必须注入的头。★ 严禁带 Referer（带了一律 403） */
const SOURCE1_HEADERS: Record<string, string> = {
  'User-Agent': MEDIA_UA,
  Accept: '*/*',
};

/**
 * 源1 签名线路额外要带的头。
 *
 * ★ 实测（2026-10-15）：`Badci` **不是必需的** —— 带上不带都能取到分片
 *   （不带反而略快）。仍按参考实现带上，跟 App 行为保持一致。
 */
const SOURCE1_SIGNED_HEADERS: Record<string, string> = {
  ...SOURCE1_HEADERS,
  Badci: BADCI,
};

/** 源2 的播放 UA。实测 CDN 不校验，带上无害 */
const SOURCE2_HEADERS: Record<string, string> = {
  'User-Agent': 'tdc.8350',
};

const formatOf = (url: string): 'hls' | 'mp4' => (/\.mp4(\?|$)/i.test(url) ? 'mp4' : 'hls');

/**
 * 从线路表里挑一条能播的。
 *
 * 优先级：备用线路（镜像，无需签名）-> m3u8 线路 -> 官方线路 -> 主线路。
 * 主线路排最后只是因为它每一步都要现算签名、链路最长；能力上它是能播的
 * （v0.2.0 的本地媒体服务补上了逐分片签名）。
 * 「备用高清」不进列表 —— 它跟主线路同址，是 App 内置 P2P 客户端才取得动的兜底线。
 */
export function pickPlayableLine(lines: PlayLine[]): PlayLine | null {
  const usable = lines.filter((l) => l.playable && !l.note);
  return (
    usable.find((l) => l.kind === 'mirror') ??
    usable.find((l) => l.kind === 'm3u8') ??
    usable.find((l) => l.kind === 'official') ??
    usable.find((l) => l.kind === 'signed') ??
    null
  );
}

/**
 * 有线路、但一条都挑不出来（只剩「备用高清」这种 P2P 兜底线）。
 *
 * 用于给用户解释"为什么明明有线路却说播不了"。
 */
export function hasOnlyBackup(lines: PlayLine[]): boolean {
  const usable = lines.filter((l) => l.playable && !l.note);
  return usable.length > 0 && !pickPlayableLine(lines);
}

/**
 * 统一出口：能起本地服务就走本地服务，起不来退回直连。
 *
 * 退回直连是**降级**不是等价：源2 会被限速、源1 主线路会 403。
 * 但总比整个播不了强，而且这个分支只会在原生模块缺失时走到。
 */
async function openLocalStream(
  target: string,
  config: MediaSessionConfig,
  format: 'hls' | 'mp4',
  lineName: string,
): Promise<ResolvedMediaStream> {
  try {
    const session = await openSession(config);
    // 播放列表线路先探一次要不要转封装（★ 必须在播放器取播放列表之前）。
    // 探测失败/不支持就照常直通 —— 见 MediaSession.prepareRemux 的注释。
    if (format === 'hls') await session.prepareRemux(target);
    return {
      streamUrl: session.streamUrl(target, format),
      format,
      headers: {},
      lineName,
      dispose: () => session.close(),
    };
  } catch {
    return {
      streamUrl: target,
      format,
      headers: config.headers,
      lineName,
      dispose: async () => {},
    };
  }
}

/**
 * 源1：线路 -> 可播放地址。
 *
 * `preferred` 让播放页在用户手选线路时复用同一条路径 —— 选谁播谁，不再自己挑。
 */
export async function resolveSource1(
  lines: PlayLine[],
  preferred?: PlayLine | null,
): Promise<ResolvedMediaStream> {
  const line = preferred ?? pickPlayableLine(lines);
  if (!line) {
    throw new Error(
      hasOnlyBackup(lines)
        ? '这批线路里只有「备用高清」有地址，那是 App 内置 P2P 客户端才取得动的兜底线，客户端播不了。'
        : '这些线路当前都播不了：主线路要接口下发真实路径，备用线路上也没有对应文件。',
    );
  }

  // 官方线路要先过第三方解析，拿到真实地址
  const target = line.kind === 'official' ? await s1.resolveOfficialLine(line) : line.url;
  const format = formatOf(target);

  return openLocalStream(
    target,
    {
      headers: line.kind === 'signed' ? SOURCE1_SIGNED_HEADERS : SOURCE1_HEADERS,
      sign: signRuleFor(line),
      // 源1 的播放列表自己不需要继承 query —— 签名由本地服务逐请求现算
      playlist: format === 'hls' ? { inheritQuery: false } : null,
    },
    format,
    line.name,
  );
}

/**
 * 源2：拿这一集的**分段列表**。
 *
 * ★ 返回的是分段不是清晰度 —— 一集可能被切成十几段 mp4（实测「OK老板娘」就是），
 *   必须按顺序连着播。清晰度用 `options.quality`（走 `sq` 参数）选。
 */
export async function source2Candidates(
  sid: string,
  episode: Episode,
  options: { quality?: number | null } = {},
): Promise<Array<Record<string, unknown>>> {
  return s2.playFor(sid, episode, options);
}

/** 源2：从分段里挑一段播出 */
export async function resolveSource2Candidate(
  item: Record<string, unknown>,
): Promise<ResolvedMediaStream> {
  const url = String(item.playUrl ?? '');
  if (!url) throw new Error('这条清晰度没有播放地址');

  const format = formatOf(url);
  return openLocalStream(
    url,
    {
      headers: SOURCE2_HEADERS,
      sign: null,
      // ★ 源2 的分片不带 query，必须继承 —— 不继承就被 CDN 限速
      playlist: format === 'hls' ? { inheritQuery: true } : null,
    },
    format,
    String(item.qualityName ?? item.src ?? '默认线路'),
  );
}

/** 源2：拿播放地址（自动挑一条） */
export async function resolveSource2(
  sid: string,
  episode: Episode,
): Promise<ResolvedMediaStream> {
  const items = await s2.playFor(sid, episode);
  const first = items.find((it) => it.playUrl);
  if (!first) throw new Error('没有拿到播放地址（该集可能受限或上游抖动）');
  return resolveSource2Candidate(first);
}

// ------------------------------------------------------------------ 投屏

/**
 * 交给接收端的一份地址（文档 §5.5）。
 *
 * ★ `direct` 是个**很重要的区别**，UI 上要如实告诉用户：
 *   - `true`（直投）：地址是裸直链，电视自己去 CDN 取流 ——
 *     **手机可以息屏、可以退出 App**，投屏不受影响
 *   - `false`（转发兜底）：流经手机的本地媒体服务 ——
 *     **手机不能休眠、不能退出 App**，否则投屏立刻断
 */
export interface CastSource {
  /** 交给电视的地址 */
  url: string;
  format: 'hls' | 'mp4';
  /** 见上 */
  direct: boolean;
  /** 这条线路的名字，UI 上显示"正在投屏 · 线路名" */
  lineName: string;
  /** 结束投屏时调；转发模式要顺带把本地会话关掉 */
  dispose: () => Promise<void>;
}

/**
 * 源1：挑一条线路，决定**直投还是转发**（文档 §5.5.3 的准入表）。
 *
 * | 线路 | 接收端能直接取吗 | 结论 |
 * | :--- | :--- | :--- |
 * | `m3u8` | 通常是裸直链 | **直投** |
 * | `official` | 第三方解析出来的多半也是裸直链 | **直投** |
 * | `mirror` | CDN 对 UA 做白名单，电视不带 `Mozi` 必 403 | 转发 |
 * | `signed` | 还要逐分片现算 `wsSecret` | 转发 |
 *
 * ★ 判错的代价是"投过去播不了"，所以这里**宁可多走转发**：
 *   转发一定能播（我们自己取流），只是手机不能息屏。直投只在确实裸的线路上用。
 */
export async function castSourceForSource1(
  lines: PlayLine[],
  preferred?: PlayLine | null,
): Promise<CastSource> {
  const line = preferred ?? pickPlayableLine(lines);
  if (!line) {
    throw new Error(
      hasOnlyBackup(lines)
        ? '这批线路里只有「备用高清」有地址，那是 App 内置 P2P 客户端才取得动的兜底线，投屏也取不到。'
        : '这些线路当前都播不了，换一条再投。',
    );
  }

  const target = line.kind === 'official' ? await s1.resolveOfficialLine(line) : line.url;
  const format = formatOf(target);
  const bare = line.kind === 'm3u8' || line.kind === 'official';

  if (bare) {
    return { url: target, format, direct: true, lineName: line.name, dispose: async () => {} };
  }

  return openCastProxy(
    target,
    {
      headers: line.kind === 'signed' ? SOURCE1_SIGNED_HEADERS : SOURCE1_HEADERS,
      sign: signRuleFor(line),
      playlist: format === 'hls' ? { inheritQuery: false } : null,
    },
    format,
    line.name,
  );
}

/**
 * 源2：一段 mp4 / m3u8。
 *
 * ★ **源2 一律走转发**：它的分片不带播放列表的 query，电视直取会被 CDN
 *   限速到几乎不下发（实测 20 秒一个字节都没下来，见 `playlistRewriter`）。
 *   必须由本地服务补 query 再喂给电视。
 */
export async function castSourceForSource2Candidate(
  item: Record<string, unknown>,
): Promise<CastSource> {
  const url = String(item.playUrl ?? '');
  if (!url) throw new Error('这条清晰度没有播放地址');
  const format = formatOf(url);
  return openCastProxy(
    url,
    {
      headers: SOURCE2_HEADERS,
      sign: null,
      playlist: format === 'hls' ? { inheritQuery: true } : null,
    },
    format,
    String(item.qualityName ?? item.src ?? '默认线路'),
  );
}

/**
 * 起一个**局域网**会话，把地址交给电视。
 *
 * ★ 拿不到局域网地址就**明确失败**，不糊弄：电视取不到手机的 `127.0.0.1`，
 *   给个回环地址过去只会得到一个"投过去一直转圈"的假象。
 */
async function openCastProxy(
  target: string,
  config: MediaSessionConfig,
  format: 'hls' | 'mp4',
  lineName: string,
): Promise<CastSource> {
  const session = await openSession(config, true);
  // `openSession` 起来之后 `currentLanHost()` 才有值 —— 所以这里才判
  if (!currentLanHost()) {
    await session.close();
    throw new Error(
      '这台设备现在没有局域网地址（多半是没连 Wi-Fi），电视取不到转发的流。\n请让手机和电视连同一个 Wi-Fi 再试。',
    );
  }

  // ★★ 投屏也要探一次要不要转封装，而且**必须赶在电视取播放列表之前**。
  //
  //   接收端（ADisplay）只看播放列表里第一个分片行的后缀决定要不要自己接手
  //   换封装：`.ts` 就判成 HEVC-in-TS，走它那条"全量下载 + FFmpeg 重封装"的
  //   路 —— 而那条路只为 Apple 的 AVPlayer 写的，在 Android 电视上跑会崩
  //   （2026-10-16 真机踩到：281 份分片下去，接收端直接退出）。
  //
  //   我们自己先转好，投过去就是**真 fMP4**：接收端判成 FragmentedMp4 ->
  //   整条换封装路径不进入。Android 不崩、Apple 也能播。
  //   转不动（H.264 线路、mp4 线路）就照常直通，行为与从前一致。
  if (format === 'hls') await session.prepareRemux(target);
  return {
    url: session.streamUrl(target, format),
    format,
    direct: false,
    lineName,
    dispose: () => session.close(),
  };
}
