/**
 * m3u8 重写器的单元测试。
 *
 * 这是「源2 能不能播」的核心逻辑，也是本机唯一能离线验证的一环
 * （原生服务要真机才跑得起来）。用例里的分片形态全部照抄
 * 2026-10-15 实网探针抓到的真实播放列表。
 */
import { describe, expect, it } from 'vitest';

import { absolutize, firstMediaSegment, rewritePlaylist } from '../src/media/playlistRewriter';

/** 把重写结果里的本地地址还原成原始地址，断言起来干净 */
const toLocal = (url: string): string => `LOCAL[${url}]`;

const PLAYLIST_URL =
  'https://voldn-ser01.51touxiang.com/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6.m3u8' +
  '?pid=XH8su%2BfqGCAq6tb%2B4qi4VIouQAnxBCtXR43h5ZRnFjI%3D&utk=u_nvzATwGTRTY8qN6geDtH' +
  '&uk=9igB7mRq1cwGKZGgKNxuCpUrtF1hCskf%2F8r0aM5R%2Fjk%3D&spl=213&t=1792064370' +
  '&sign=caff80158b4df33602e7c6d9a02c1dee&ip=218.79.121.36';

const SEGMENT_QUERY =
  '?pid=XH8su%2BfqGCAq6tb%2B4qi4VIouQAnxBCtXR43h5ZRnFjI%3D&utk=u_nvzATwGTRTY8qN6geDtH' +
  '&uk=9igB7mRq1cwGKZGgKNxuCpUrtF1hCskf%2F8r0aM5R%2Fjk%3D&spl=213&t=1792064370' +
  '&sign=caff80158b4df33602e7c6d9a02c1dee&ip=218.79.121.36';

describe('absolutize', () => {
  it('★ 以 / 开头的分片用 origin 拼，不是拿目录拼', () => {
    // 拼错会得到 .../m3u8//m3u8/... —— 实网探针第一轮就是这么栽的
    expect(absolutize('/m3u8/a/b.ts', PLAYLIST_URL)).toBe(
      'https://voldn-ser01.51touxiang.com/m3u8/a/b.ts',
    );
  });

  it('相对分片用播放列表所在目录拼', () => {
    // 播放列表在 /m3u8/nyBW....m3u8，所以它的目录就是 /m3u8/
    expect(absolutize('seg/b.ts', PLAYLIST_URL)).toBe(
      'https://voldn-ser01.51touxiang.com/m3u8/seg/b.ts',
    );
  });

  it('已经是绝对地址就原样返回', () => {
    const abs = 'https://cdn.example.com/x.ts';
    expect(absolutize(abs, PLAYLIST_URL)).toBe(abs);
  });
});

describe('源2：分片补 query（限速的解法）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:11',
    '',
    '#EXTINF:10.000,',
    '/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6/JgW_2tGOzG_000000.ts',
    '#EXTINF:10.000,',
    '/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6/JgW_2tGOzG_000001.ts',
    '',
  ].join('\n');

  it('每条分片都带上播放列表的 query，并指向本地服务', () => {
    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: true, toLocal });

    expect(out).toContain(
      `LOCAL[https://voldn-ser01.51touxiang.com/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6/JgW_2tGOzG_000000.ts${SEGMENT_QUERY}]`,
    );
    expect(out).toContain(
      `LOCAL[https://voldn-ser01.51touxiang.com/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6/JgW_2tGOzG_000001.ts${SEGMENT_QUERY}]`,
    );
  });

  it('注释行与空行原样保留', () => {
    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: true, toLocal });
    expect(out.split('\n')[0]).toBe('#EXTM3U');
    expect(out.split('\n')[1]).toBe('#EXT-X-VERSION:3');
    expect(out.split('\n')[3]).toBe('');
  });

  it('分片本来就带 sign= 就不重复补', () => {
    const already = `#EXTM3U\n/seg/a.ts?sign=deadbeef&x=1\n`;
    const out = rewritePlaylist(already, PLAYLIST_URL, { inheritQuery: true, toLocal });
    expect(out).toContain('LOCAL[https://voldn-ser01.51touxiang.com/seg/a.ts?sign=deadbeef&x=1]');
    // 没有把播放列表那串 query 再拼一遍
    expect(out).not.toContain('sign=deadbeef&x=1&pid=');
  });

  it('inheritQuery=false 时不补 query（源1 主线路走这条）', () => {
    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: false, toLocal });
    expect(out).toContain('LOCAL[https://voldn-ser01.51touxiang.com/m3u8/nyBWJDBnsT2IR_1GysEq_mMdcwZ1Gn8WK1Ih9Ze6/JgW_2tGOzG_000000.ts]');
    expect(out).not.toContain('pid=');
  });
});

describe('URI="..." 属性', () => {
  it('★ #EXT-X-KEY / #EXT-X-MAP 的 URI 也要走本地服务', () => {
    // 不换的话播放器会拿相对路径去问本地服务，必然 404
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
      '#EXT-X-MAP:URI="/init/init.mp4"',
      '#EXTINF:10.000,',
      '/seg/000.ts',
    ].join('\n');

    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: false, toLocal });
    // 相对 URI 的基准是**播放列表所在目录**（`/m3u8/`），与浏览器/播放器一致
    expect(out).toContain('URI="LOCAL[https://voldn-ser01.51touxiang.com/m3u8/key.bin]"');
    expect(out).toContain('URI="LOCAL[https://voldn-ser01.51touxiang.com/init/init.mp4]"');
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128');
    expect(out).toContain('IV=0x1');
  });

  it('URI 属性同样受 inheritQuery 影响', () => {
    const text = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"';
    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: true, toLocal });
    expect(out).toContain('key.bin?pid=');
  });
});

describe('源1 主线路：分片带自己的参数', () => {
  it('分片自带的 m8/sz 原样保留，交给本地服务现算签名', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXTINF:2.000,',
      'output_000000.ts?m8=3c87e0489ca54ac0&sz=668340',
    ].join('\n');

    const out = rewritePlaylist(
      text,
      'http://dgxj.hjhggs.com/vod/m3u8/2/2026/10/091204/4529121/index3.m3u8',
      { inheritQuery: false, toLocal },
    );
    expect(out).toContain(
      'LOCAL[http://dgxj.hjhggs.com/vod/m3u8/2/2026/10/091204/4529121/output_000000.ts?m8=3c87e0489ca54ac0&sz=668340]',
    );
  });
});

describe('边界', () => {
  it('播放列表地址解析不了时不补 query，但仍然代理', () => {
    const out = rewritePlaylist('#EXTM3U\n/seg/a.ts\n', 'not a url', {
      inheritQuery: true,
      toLocal,
    });
    expect(out).toContain('LOCAL[/seg/a.ts]');
  });

  it('结尾换行不丢', () => {
    const out = rewritePlaylist('#EXTM3U\n/seg/a.ts\n', PLAYLIST_URL, {
      inheritQuery: false,
      toLocal,
    });
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('firstMediaSegment（转封装探测要取的第一片）', () => {
  it('跳过注释与空行，取第一条分片', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:11',
      '',
      '#EXTINF:10.000,',
      '/m3u8/a/000.ts',
      '#EXTINF:10.000,',
      '/m3u8/a/001.ts',
    ].join('\n');

    expect(firstMediaSegment(text, PLAYLIST_URL, true)).toBe(
      `https://voldn-ser01.51touxiang.com/m3u8/a/000.ts${SEGMENT_QUERY}`,
    );
  });

  it('与 rewritePlaylist 用的是同一套规则（同一片地址必须一致）', () => {
    // 两处规则若各写一份，探测就会去取一个播放器根本不会取的地址
    const text = '#EXTM3U\n#EXTINF:10.000,\n/seg/000.ts\n';
    const first = firstMediaSegment(text, PLAYLIST_URL, true);
    const rewritten = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: true, toLocal });
    expect(rewritten).toContain(`LOCAL[${first}]`);
  });

  it('全是注释时返回 null（不是空串）', () => {
    expect(firstMediaSegment('#EXTM3U\n#EXT-X-ENDLIST\n', PLAYLIST_URL, false)).toBeNull();
  });
});

describe('转封装会话：补 #EXT-X-MAP 并顶高版本号', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:13',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:12.000,',
    'output_1.ts?m8=aa&sz=1',
    '#EXTINF:6.800,',
    'output_2.ts?m8=bb&sz=2',
  ].join('\n');

  const MAP = 'LOCAL-INIT';

  it('★ #EXT-X-MAP 落在第一条 #EXTINF 之前，版本顶到 7', () => {
    const out = rewritePlaylist(text, PLAYLIST_URL, {
      inheritQuery: false,
      toLocal,
      mapUri: MAP,
    });
    const lines = out.split('\n');

    expect(lines).toContain(`#EXT-X-MAP:URI="${MAP}"`);
    expect(lines).toContain('#EXT-X-VERSION:7');
    expect(lines).not.toContain('#EXT-X-VERSION:3');

    // MAP 必须在第一条分片（#EXTINF）之前
    expect(lines.indexOf(`#EXT-X-MAP:URI="${MAP}"`)).toBeLessThan(
      lines.indexOf('#EXTINF:12.000,'),
    );
  });

  it('没写版本行的播放列表，紧跟 #EXTM3U 补一条', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXTINF:1.000,\n/a.ts\n', PLAYLIST_URL, {
      inheritQuery: false,
      toLocal,
      mapUri: MAP,
    });
    const lines = out.split('\n');
    expect(lines[1]).toBe('#EXT-X-VERSION:7');
  });

  it('不传 mapUri 时播放列表结构一点不动', () => {
    const out = rewritePlaylist(text, PLAYLIST_URL, { inheritQuery: false, toLocal });
    expect(out).not.toContain('#EXT-X-MAP');
    expect(out).toContain('#EXT-X-VERSION:3');
  });
});
