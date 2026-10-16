/**
 * m3u8 播放列表重写。
 *
 * 与 `参考/影视站api2.js` 的 `rewriteM3u8()` 一一对应，外加 `参考/影视站api1.js`
 * 里对 `URI="..."` 属性（`#EXT-X-KEY` / `#EXT-X-MAP`）的处理。
 *
 * ★ 这个函数是「源2 能不能播」的关键，两个坑都是实测出来的：
 *
 *   1. **分片必须带上播放列表自身那串 query**（`pid/utk/uk/spl/t/sign/ip`）。
 *      不带的话 CDN **照样回 200、字节也完全正确**，但会限速 ——
 *      实测（2026-10-15）不是文档里记的 1KB/s，而是**干脆一个字节都不下发**；
 *      补上 query 后立刻恢复（64KB / 49ms / 1306 kbps）。
 *   2. 分片可能是**以 `/` 开头的根相对路径**，必须用 **origin** 拼，
 *      不能拿播放列表的目录拼 —— 拼错会得到 `.../m3u8//m3u8/...` 这种地址。
 *
 * 重写结果一律指向本地媒体服务（见 `mediaServer.ts`），由服务负责注入请求头、
 * 现算分片签名、透传 Range —— 播放器侧因此不再需要任何自定义头能力（文档 §6.2）。
 */

export interface PlaylistRewriteOptions {
  /** 分片是否继承播放列表自身的 query（源2 必需，源1 主线路不要） */
  inheritQuery: boolean;
  /** 原始绝对地址 -> 本地媒体服务地址 */
  toLocal: (absoluteUrl: string) => string;
  /**
   * 转封装会话（HEVC-TS -> fMP4）要补的 `#EXT-X-MAP` 初始化分片地址。
   *
   * 不传 / 传 null = 完全不碰播放列表结构（普通会话的默认行为）。
   * 传了就把 `#EXT-X-VERSION` 顶到 7 —— 见 `withInitSegment` 的注释。
   */
  mapUri?: string | null;
}

const ABSOLUTE = /^https?:\/\//i;

/** 把播放列表里的一条地址补成绝对地址 */
export function absolutize(target: string, playlistUrl: string): string {
  if (ABSOLUTE.test(target)) return target;

  let base: URL;
  try {
    base = new URL(playlistUrl);
  } catch {
    // 播放列表地址本身解析不了（理论上不会发生）—— 原样返回，交给上层兜底
    return target;
  }

  // ★ 以 / 开头的是**根相对**路径，拼 origin 而不是目录
  if (target.startsWith('/')) return base.origin + target;

  // ★ 基准要从 pathname 算，不能拿整串 URL 找最后一个 '/' ——
  //   播放列表的 query 里一旦出现字面量 '/'，基准就会落到 query 里去。
  const dir = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  return base.origin + dir + target;
}

/**
 * 分片地址的最终形态：绝对化 -> （源2）继承 query。
 *
 * `rewritePlaylist`（改地址）和 `firstMediaSegment`（挑第一片去探测）共用同一份规则 ——
 * 两处各写一遍的话，改了 query 规则只改一处，探测就会去取一个取不到的地址。
 */
export function decorateUrl(target: string, playlistUrl: string, inheritQuery: boolean): string {
  const absolute = absolutize(target, playlistUrl);
  if (!inheritQuery) return absolute;

  let query = '';
  try {
    query = new URL(playlistUrl).search.replace(/^\?/, '');
  } catch {
    return absolute;
  }
  if (!query || absolute.includes('sign=')) return absolute;
  return absolute + (absolute.includes('?') ? '&' : '?') + query;
}

/**
 * 播放列表里**第一条分片**的绝对地址。
 *
 * 给"这条线路要不要转封装"的探测用：探测必须拿真实分片去试（见
 * `mediaServer.ts` 的 `prepareRemux`），而地址怎么拼是这里说了算。
 */
export function firstMediaSegment(
  text: string,
  playlistUrl: string,
  inheritQuery: boolean,
): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return decorateUrl(trimmed, playlistUrl, inheritQuery);
  }
  return null;
}

/**
 * 重写一份播放列表。
 *
 * 注释行与空行原样保留（`URI="..."` 属性除外），其余每行都换成指向本地服务的地址。
 */
export function rewritePlaylist(
  text: string,
  playlistUrl: string,
  options: PlaylistRewriteOptions,
): string {
  const { inheritQuery, toLocal, mapUri } = options;

  /** 绝对化 -> （源2）补 query -> 换成本地地址 */
  const decorate = (target: string): string =>
    toLocal(decorateUrl(target, playlistUrl, inheritQuery));

  const body = text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 的 URI 属性也要一起走本地服务，
        // 否则播放器会拿相对路径去问本地服务，必然 404。
        const match = /URI="([^"]+)"/.exec(line);
        return match ? line.replace(/URI="[^"]+"/, () => `URI="${decorate(match[1])}"`) : line;
      }
      return decorate(trimmed);
    })
    .join('\n');

  const completed = withEndList(body);
  return mapUri ? withInitSegment(completed, mapUri) : completed;
}

/**
 * 播放列表**没有 `#EXT-X-ENDLIST` 就补一个**。
 *
 * ★★ 这是 2026-10-16 定位到的投屏崩溃根因，**别删**。
 *
 *   上游的 m3u8 是「直播式切片」——国内影视站很常见：分片清单是定长的、
 *   实际就是点播，但**不带 `#EXT-X-ENDLIST`**。
 *
 *   HLS 里这个标签的含义是「列表到头了」：
 *     - 有它 → VOD，播放器知道总共这么多，往下播完就结束；
 *     - 没有 → 播放器认为这是**直播**，列表还会增长，于是**反复重拉播放列表**
 *       等新分片出现 —— 而那个新分片永远不会来。
 *
 *   投屏场景下的表现就是：拉了几次播放列表、取了一两个分片，然后卡住/崩
 *   （接收端那边看到的正是这个形状）。
 *
 * ★ 接收端自己也有过同样的坑：它的 `MediaRelay` 里对"没有 ENDLIST"单独
 *   记了一条警告并**按 VOD 处理**。但那只兜住了它自己的中转；播放器直接
 *   取我们的列表时没有这层兜底 —— 而我们现在走的正是这条路。
 *
 * ★ 我们的源全是点播（影视剧），补上它是正确的。真遇到直播源时，这样做的
 *   后果是"播到当前这一批就停"，而不是无限重拉 —— 仍然是更合理的行为。
 */
function withEndList(body: string): string {
  if (/#EXT-X-ENDLIST/i.test(body)) return body;
  return body.endsWith('\n') ? `${body}#EXT-X-ENDLIST\n` : `${body}\n#EXT-X-ENDLIST\n`;
}

/**
 * 转封装会话：补上 `#EXT-X-MAP`，并把 `#EXT-X-VERSION` 顶到 7。
 *
 * ★ 两件事都必须做，少一件播放器都可能直接不认：
 *   1. `#EXT-X-MAP` 指向 init 分片（moov），缺了它 fMP4 分片就是无头数据。
 *      位置必须在**第一条分片之前**（插在第一个 `#EXTINF` 前面最直观）。
 *   2. Apple 的 HLS 规范要求 HEVC 用 `EXT-X-VERSION:7`，而源站播放列表
 *      常见的是 `EXT-X-VERSION:3`（TS 时代的老写法）。版本不顶上去，
 *      播放器会按老规矩解析 —— 分片已经不是 `.ts` 了。
 */
function withInitSegment(text: string, mapUri: string): string {
  const lines = text.split('\n');
  const hasVersion = lines.some((line) => /^#EXT-X-VERSION:/i.test(line.trim()));

  const out: string[] = [];
  let insertedMap = false;
  let insertedVersion = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#EXT-X-VERSION:/i.test(trimmed)) {
      out.push('#EXT-X-VERSION:7');
      continue;
    }
    if (!insertedMap && /^#EXTINF:/i.test(trimmed)) {
      out.push(`#EXT-X-MAP:URI="${mapUri}"`);
      insertedMap = true;
    }
    out.push(line);

    // 播放列表没写版本行的话，紧跟 #EXTM3U 补一条（版本要在 MAP 前面更稳妥）
    if (!hasVersion && !insertedVersion && /^#EXTM3U/i.test(trimmed)) {
      out.push('#EXT-X-VERSION:7');
      insertedVersion = true;
    }
  }

  return out.join('\n');
}
