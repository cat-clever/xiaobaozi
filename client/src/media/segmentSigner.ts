/**
 * 源1 主线路的分片签名规则。
 *
 * 与 `参考/影视站api1.js` 的 `wsSecret()` / `signQuery()` 一一对应：
 *
 *   wsSecret = MD5(ws_key + path + "%x" % ws_time)   小写 hex
 *
 * ★ 有效期约 30 秒 —— 所以**不可能**把签名预生成进播放列表，
 *   只能由本地媒体服务在**每次分片请求时**现算。
 *   这也是"重写播放列表"和"逐分片签名"必须分两件事的原因。
 *
 * ★ 这里只产出**规则**，实际计算在原生侧做（每次请求都要算，
 *   走一次 JS 桥接不划算）。规则本身留在 TS —— 上游改了算法只动这个文件。
 */
import type { PlayLine } from '../types/schema';

export interface SignRule {
  /** md5 输入模板，占位符：`{key}` `{path}` `{tsHex}` `{ts}` */
  template: string;
  /** 马甲的 CDN 密钥 —— 每个马甲一把，不可混用 */
  key: string;
  /** 签名写进哪个 query 参数 */
  param: string;
  /** 时间戳写进哪个 query 参数（值为 hex） */
  tsParam: string;
  /** 签名前从原 query 里剔掉的参数（留着会撞 462） */
  drop: string[];
  /** 额外拼进 query 的片段 —— `ck` 解出来的 `k=..&Time=..&uid=..`，不参与 md5 */
  extra: string;
}

/** 与参考实现逐字节对齐的 md5 输入模板 */
export const WS_SECRET_TEMPLATE = '{key}{path}{tsHex}';

/**
 * 给一条线路造签名规则。
 *
 * 只有 `kind === 'signed'` 的线路需要 —— 镜像线路 / m3u8 线路 / 官方线路
 * 都是**不需要签名**的直链，多签一次反而会被源站拒。
 */
export function signRuleFor(line: PlayLine): SignRule | null {
  if (line.kind !== 'signed') return null;
  const key = line.wsKey ?? '';
  if (!key) return null;
  return {
    template: WS_SECRET_TEMPLATE,
    key,
    param: 'wsSecret',
    tsParam: 'wsTime',
    drop: ['wsSecret', 'wsTime'],
    // ★ ck 必须拼进 query（少了源站回 463：签名对但访问凭证缺），但不进 md5 输入
    extra: line.ck ?? '',
  };
}
