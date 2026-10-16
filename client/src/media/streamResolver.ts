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
import { openSession } from './mediaServer';
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
