/**
 * DLNA 的**纯解析逻辑**。
 *
 * ★★ 为什么单独一个文件：这里**不 import `react-native`** ——
 *   于是能在 vitest 的 node 环境里直接跑（见 `__tests__/cast.test.ts`）。
 *   投屏最容易翻车的就是"电视的 XML 长什么样"这一层，而这层恰恰是
 *   **不用真机就能验**的。IO（发现、SOAP 收发）在 `dlna.ts`。
 *
 * ★ 所有函数一律**从宽**：抠不出来就给空串 / null，**绝不抛异常**。
 *   用户 2026-10-16 的硬要求：「最宽松校验，省的无法投屏在电视上」。
 */
import { allBlocks, attrOf, tagText } from './xml';

/** UPnP 的 AVTransport 服务类型。★ 只用来判断"是不是它"，版本号按描述里的原样留 */
export const AVTRANSPORT = 'avtransport';

/** 一份文档像不像 UPnP 设备描述 —— 只用来决定"要不要启用兜底猜测" */
const LOOKS_LIKE_DESCRIPTION = /<\s*(?:[\w.-]+:)?(?:root|device)\b/i;

/** 描述里找不到 `AVTransport` 时按描述地址猜的几个常见控制路径 */
const GUESSED_PATHS = [
  '/AVTransport/control',
  '/upnp/control/AVTransport1',
  '/upnp/control/AVTransport',
  '/AVTransport/ctrl',
];

/**
 * 控制地址候选表**末尾**再挂的兜底路径。
 *
 * ★ 前面那三种基准全拼错时才轮到它们（设备把 `controlURL` 写成怪相对路径、
 *   `URLBase` 又乱，怎么拼都不对）。反正只在 404 之后才试，成本就是几次
 *   局域网内的 404 往返。`/control` 排第一 —— 2026-10-16 那台接收端用的就是它。
 */
const FALLBACK_PATHS = ['/control', ...GUESSED_PATHS];

export interface ParsedDescription {
  udn: string;
  friendlyName: string;
  modelName: string;
  /** 首选控制地址（= `controlUrls[0]`） */
  controlUrl: string;
  /**
   * 控制地址的**候选表**，首选在前。
   *
   * ★ 为什么要好几个：`URLBase` 这东西各家写法不一，同一个描述用不同的基准
   *   解析出来的控制路径可能不一样，而我们**没法提前知道哪台设备认哪个**。
   *   投屏时按顺序试，哪个不是 404 就用哪个（见 `dlna.ts` 的 `soap`）。
   *   用户 2026-10-16 的硬要求是「最宽松校验」，这里是同一条思路。
   */
  controlUrls: string[];
  serviceType: string;
}

/**
 * 解析设备描述 XML。
 *
 * ★ **全文档扫 `<service>`**，不只扫根 `<device>`：很多电视把 AVTransport
 *   放在**内嵌设备**（`<deviceList><device>`）里，只认根节点就会漏。
 * ★ `serviceType` **忽略大小写、不校验版本号** —— `AVTransport:2` / `:3` 都认，
 *   版本号原样留着给 SOAPACTION 用（写错有的电视直接拒）。
 * ★ `serviceType` 空着或乱写、但控制路径里写着 AVTransport 的，也认。
 */
export function parseDescription(xml: string, descriptionUrl: string): ParsedDescription | null {
  const rawBase = tagText(xml, 'URLBase');
  const base = normalizeBase(rawBase, descriptionUrl);

  let controlUrls: string[] = [];
  let serviceType = '';
  for (const block of allBlocks(xml, 'service')) {
    const type = tagText(block, 'serviceType');
    const control = tagText(block, 'controlURL');
    if (!control) continue;
    if (type.toLowerCase().includes(AVTRANSPORT)) {
      controlUrls = controlCandidates(base, rawBase, descriptionUrl, control);
      serviceType = type;
      break;
    }
    if (!controlUrls.length && control.toLowerCase().includes(AVTRANSPORT)) {
      controlUrls = controlCandidates(base, rawBase, descriptionUrl, control);
      serviceType = type || 'urn:schemas-upnp-org:service:AVTransport:1';
    }
  }

  // ★ 只在"这份文档确实像一份 UPnP 设备描述"时才去猜控制路径。
  //   不设这道门的话，`LOCATION` 指到别的东西（一个 404 页、一段 JSON）时
  //   也会猜出一个地址 —— 列表里就多一台**点不动的幽灵设备**，
  //   用户点了才发现投不了。宁可少一台，也不要一台假的。
  if (!controlUrls.length && LOOKS_LIKE_DESCRIPTION.test(xml)) {
    const guessed = guessControlUrl(base);
    if (guessed) controlUrls = [guessed];
  }
  if (!controlUrls.length) return null;

  return {
    udn: tagText(xml, 'UDN'),
    friendlyName: tagText(xml, 'friendlyName'),
    modelName: tagText(xml, 'modelName') || tagText(xml, 'manufacturer'),
    controlUrl: controlUrls[0],
    controlUrls,
    serviceType: serviceType || 'urn:schemas-upnp-org:service:AVTransport:1',
  };
}

/**
 * 控制地址的候选表。
 *
 * ★ 三种基准各算一份，去重后按可靠性排序：
 *   1. **规整过的 `URLBase`** —— 首选（`URLBase` 写成文件名的设备见 `normalizeBase`）
 *   2. **原样的 `URLBase`** —— 万一规整错了（设备真就想以那个路径为基准）
 *   3. **描述自己的地址** —— 连 `URLBase` 都没有时的兜底
 * 投屏时按顺序试，哪个不是 404 就用哪个。
 */
export function controlCandidates(
  base: string,
  rawBase: string,
  descriptionUrl: string,
  control: string,
): string[] {
  const out: string[] = [];
  const push = (url: string) => {
    if (url && !out.includes(url)) out.push(url);
  };
  push(resolveUrl(base, control));
  if (rawBase.trim()) push(resolveUrl(rawBase.trim(), control));
  push(resolveUrl(descriptionUrl, control));
  // ★ 最后挂兜底：上面全不对时，至少还有一次"按惯例猜"的机会。
  //   只在前面都回了 404 之后才会轮到它们（见 `dlna.ts` 的 `soap`）。
  const root = rootOf(base) || rootOf(descriptionUrl);
  if (root) for (const path of FALLBACK_PATHS) push(`${root}${path}`);
  return out;
}

/**
 * 描述里找不到 `AVTransport` 时的**兜底猜测**。
 * ★ 只在"扫遍全文档都没有"时才走 —— 猜错了也就是这台设备投不了，不影响别的设备。
 */
export function guessControlUrl(base: string): string {
  const root = rootOf(base);
  return root ? `${root}${GUESSED_PATHS[0]}` : '';
}

/**
 * 把 `URLBase` 规整成**目录**形式。
 *
 * ★★ UPnP 规范里 `URLBase` 该是 `http://host:port/` 这种目录，但实测有设备
 *   （2026-10-16：接收端 ADisplay）把它写成**自己描述文件的完整地址**
 *   `http://host:port/description.xml`。拿它当基准解析相对的控制路径，
 *   就会拼出 `http://host:port/description.xml/control` 这种根本不存在的地址。
 *
 *   后果很隐蔽：设备对那个路径回 **404**，而 404 的正文里没有 SOAP Fault，
 *   `postSoap` 那句"以正文为准"于是把它当成**投屏成功** ——
 *   用户看到"正在投屏到 X"，电视却一动不动（对照实验：B 站投同一台设备
 *   用的是 `/control`，一次就成）。
 *
 * 所以：路径最后一段看着像文件名（带 `.`）就退到它所在目录。
 * 拿不准就原样返回 —— 候选表里还留着原样那一份（见 `controlCandidates`）。
 */
export function normalizeBase(raw: string, fallback: string): string {
  const base = raw.trim() || fallback;
  try {
    const url = new URL(base);
    const path = url.pathname;
    // ★ 先去掉尾斜杠再看最后一段：`.../description.xml/` 这种写法同样要退到
    //   目录 —— 拿它当 base，`control` 会拼成 `/description.xml/control`。
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
    if (!trimmed) return base;
    const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    if (!last.includes('.')) return base;
    return `${url.protocol}//${url.host}${trimmed.slice(0, trimmed.lastIndexOf('/') + 1)}`;
  } catch {
    return base;
  }
}

/** 相对地址 -> 绝对地址。★ 根相对 / 目录相对 / 已经是绝对的，三种都认 */
export function resolveUrl(base: string, relative: string): string {
  const rel = relative.trim();
  if (!rel) return '';
  if (/^https?:\/\//i.test(rel)) return rel;
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

/** 取 URL 的 `scheme://host[:port]`。取不到回空串 */
export function rootOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** DLNA 的状态串归一化。认不出来一律 `unknown`，别瞎猜 */
export function normalizeState(raw: string): 'playing' | 'paused' | 'stopped' | 'transitioning' | 'unknown' {
  switch (raw.trim().toUpperCase()) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED_PLAYBACK':
    case 'PAUSED_RECORDING':
    case 'PAUSED':
      return 'paused';
    case 'STOPPED':
    case 'NO_MEDIA_PRESENT':
      return 'stopped';
    case 'TRANSITIONING':
      return 'transitioning';
    default:
      return 'unknown';
  }
}

/**
 * 从响应里抠 SOAP Fault 的说明。没有 fault 就回空串。
 * ★ 不看 HTTP 状态码：不少设备失败时也回 200，错误藏在 Fault 里。
 */
export function faultOf(xml: string): string {
  if (!/fault/i.test(xml)) return '';
  const reason =
    tagText(xml, 'faultstring') || tagText(xml, 'errorDescription') || tagText(xml, 'errorCode');
  return reason ? reason.trim() : '设备返回了 SOAP Fault';
}

/** 拼一个 SOAP 信封 */
export function buildEnvelope(
  serviceType: string,
  action: string,
  args: Record<string, string>,
): string {
  const inner = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">${inner}</u:${action}>` +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

/**
 * DIDL-Lite 元数据。
 * ★ 有些电视非要它不可，有些又会被它噎住 —— 见 `dlna.ts` 的 `dlnaCast` 重试。
 */
export function buildMetadata(url: string, title: string): string {
  const safeTitle = escapeXml(title || 'Video');
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${safeTitle}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:video/*:*">${escapeXml(url)}</res>` +
    '</item>' +
    '</DIDL-Lite>'
  );
}

/** ★ `&` 必须**第一个**换，否则会把后面换出来的 `&amp;lt;` 二次解成 `&lt;` */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { attrOf };
