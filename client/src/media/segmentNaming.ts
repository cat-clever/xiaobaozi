/**
 * 本地媒体服务里**分片与播放列表的命名**。
 *
 * ★ 单独一个文件、不 import `react-native`：命名是纯字符串逻辑，而它直接
 *   决定接收端会不会走错路（见 `localSegmentName` 里投屏那一条），
 *   必须在 vitest 里能直接覆盖。
 */

/** 取播放地址里最后一段当文件名 —— 播放器靠后缀选对管线（.m3u8 / .mp4 / .ts） */
export function basenameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.slice(path.lastIndexOf('/') + 1);
    if (last && last.includes('.')) return last;
    return `${last || 'index'}.ts`;
  } catch {
    return 'seg.ts';
  }
}

export interface NamingMode {
  /** 转封装会话：内容已经是 fMP4，如实报 `.m4s` */
  remuxing: boolean;
  /** 投屏会话：**连 `.ts` 都不留**（见下） */
  forCast: boolean;
}

/**
 * 上游分片地址 -> 本地代理地址里那个文件名。
 *
 * ★★ `forCast` 那条是 2026-10-16 的真机修复，**别顺手删**。
 *
 *   接收端（ADisplay）在播放列表里**只看第一个分片行的后缀**判断要不要接手
 *   换封装：`.ts` -> "这是 HEVC-in-TS，Apple 的播放器吃不下，我换一遍"，
 *   其余 -> "不用管，原样交给系统播放器"。
 *
 *   那套换封装是**为 AVPlayer 写的**（Apple 的 HLS 规范要求 HEVC 用 fMP4），
 *   但它在 Android 电视上也会被触发 —— 而电视端 ExoPlayer 本来就支持
 *   HEVC-in-TS，根本不需要换，走了反而**崩**：281 份分片全部下载 + FFmpeg
 *   逐个重封装，日志停在「本地中转就绪：281 份分片」就没有下文了。
 *
 *   所以投屏时把 `.ts` 去掉：接收端判成"认不出来" -> 302 回我们的地址 ->
 *   整条换封装路径不进入。播放器侧不受影响 —— ExoPlayer 对分片走**内容嗅探**
 *   （由播放列表里有没有 `#EXT-X-MAP` 决定），跟分片文件名无关。
 *
 * ★ 代价：Apple 接收端（AVPlayer）遇到 HEVC-in-TS 的源会变成"有声音没画面"。
 *   那本来也是它自己的限制，而且比"整个接收端崩掉"轻得多。要两边都顾上，
 *   得按接收端的 UA 分别取名（UA 只在取流时才看得到，得走原生），
 *   那是另一件事 —— 见 `改动记录.md` 第四十四轮。
 */
export function localSegmentName(upstreamUrl: string, mode: NamingMode): string {
  const name = basenameOf(upstreamUrl);
  if (mode.remuxing) return name.replace(/\.ts$/i, '.m4s');
  if (mode.forCast) {
    // 只动媒体分片；`.key` / `.m3u8` 之类原样保留
    const stripped = name.replace(/\.ts$/i, '');
    return stripped || name; // 极端情况下别把名字弄成空的
  }
  return name;
}
