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

export interface ParsedDescription {
  udn: string;
  friendlyName: string;
  modelName: string;
  controlUrl: string;
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
  const base = tagText(xml, 'URLBase') || descriptionUrl;

  let controlUrl = '';
  let serviceType = '';
  for (const block of allBlocks(xml, 'service')) {
    const type = tagText(block, 'serviceType');
    const control = tagText(block, 'controlURL');
    if (!control) continue;
    if (type.toLowerCase().includes(AVTRANSPORT)) {
      controlUrl = resolveUrl(base, control);
      serviceType = type;
      break;
    }
    if (!controlUrl && control.toLowerCase().includes(AVTRANSPORT)) {
      controlUrl = resolveUrl(base, control);
      serviceType = type || 'urn:schemas-upnp-org:service:AVTransport:1';
    }
  }

  // ★ 只在"这份文档确实像一份 UPnP 设备描述"时才去猜控制路径。
  //   不设这道门的话，`LOCATION` 指到别的东西（一个 404 页、一段 JSON）时
  //   也会猜出一个地址 —— 列表里就多一台**点不动的幽灵设备**，
  //   用户点了才发现投不了。宁可少一台，也不要一台假的。
  if (!controlUrl && LOOKS_LIKE_DESCRIPTION.test(xml)) controlUrl = guessControlUrl(base);
  if (!controlUrl) return null;

  return {
    udn: tagText(xml, 'UDN'),
    friendlyName: tagText(xml, 'friendlyName'),
    modelName: tagText(xml, 'modelName') || tagText(xml, 'manufacturer'),
    controlUrl,
    serviceType: serviceType || 'urn:schemas-upnp-org:service:AVTransport:1',
  };
}

/**
 * 描述里找不到 `AVTransport` 时的**兜底猜测**。
 * ★ 只在"扫遍全文档都没有"时才走 —— 猜错了也就是这台设备投不了，不影响别的设备。
 */
export function guessControlUrl(base: string): string {
  const root = rootOf(base);
  return root ? `${root}${GUESSED_PATHS[0]}` : '';
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
