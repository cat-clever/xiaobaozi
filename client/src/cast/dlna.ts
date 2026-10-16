/**
 * DLNA / UPnP 投屏的 **IO 层**（双端共用）。
 *
 * 纯解析（设备描述、SOAP 信封、状态归一化）在 `dlnaParse.ts` —— 那边不 import
 * `react-native`，能在 node 环境里单测。这里只干"发请求、收请求"。
 *
 * ★★ **一切从宽**（用户 2026-10-16：「最宽松校验，省的无法投屏在电视上」）：
 *   · 收设备：只要有 `LOCATION` 就拉描述，**不按 ST/USN/Server 过滤**
 *   · 找服务：全文档扫、忽略大小写、不校验版本号；找不到就猜常见路径
 *   · 设备名：`friendlyName` -> `modelName` -> 主机地址，读不到也**不丢设备**
 *   · SOAP：换一种 `SOAPACTION` 写法重试；`SetAVTransportURI` 再失败就
 *     **去掉 DIDL 元数据**重试（很多电视不接受元数据，去掉反而能播）
 */
import { SsdpNative } from './NativeSsdp';
import {
  AVTRANSPORT,
  buildEnvelope,
  buildMetadata,
  faultOf,
  normalizeState,
  parseDescription,
  resolveUrl,
} from './dlnaParse';
import type { CastDevice, CastTransportState, SsdpHit } from './types';

/** 拉一份设备描述的超时。★ 短一点：一台电视没响应不该拖住整个发现 */
const DESCRIBE_TIMEOUT_MS = 2500;
/** SOAP 调用的超时。电视执行 `SetAVTransportURI` 有时要好几秒 */
const SOAP_TIMEOUT_MS = 8000;
/** 同时拉几份描述 —— 电视多的时候别一次开几十个连接 */
const DESCRIBE_CONCURRENCY = 6;

/** 设备描述里读不到 `serviceType` 时的兜底（SOAPACTION 要它） */
const DEFAULT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

// ---------------------------------------------------------------- 发现

/**
 * 发现局域网里所有能投的 DLNA 设备。
 *
 * ★ **两级筛选**：先只看 SSDP 里声明自己是 MediaRenderer 的（快、准），
 *   一个都没有时再回头把剩下的全拉一遍描述 —— 国产电视里不声明 `ST` 的不少，
 *   一刀切会把它们全漏掉。
 */
export async function discoverDlnaDevices(timeoutMs = 4000): Promise<CastDevice[]> {
  if (!SsdpNative) return [];
  let hits: SsdpHit[] = [];
  try {
    hits = await SsdpNative.discover(timeoutMs);
  } catch {
    return [];
  }
  if (!hits.length) return [];

  // 按 location 去重（同一台设备会为三个 ST 各回一次）
  const byLocation = new Map<string, SsdpHit>();
  for (const hit of hits) {
    if (hit.location && !byLocation.has(hit.location)) byLocation.set(hit.location, hit);
  }
  const unique = Array.from(byLocation.values());

  const looksLikeRenderer = (hit: SsdpHit): boolean =>
    `${hit.st} ${hit.usn} ${hit.server}`.toLowerCase().includes('mediarenderer');

  const found = await describeAll(unique.filter(looksLikeRenderer));
  // ★ 声明了 MediaRenderer 的一台都没成，才去啃其余的（含路由器这类噪音）
  if (!found.length) {
    found.push(...(await describeAll(unique.filter((h) => !looksLikeRenderer(h)))));
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function describeAll(hits: SsdpHit[]): Promise<CastDevice[]> {
  const out: CastDevice[] = [];
  for (let i = 0; i < hits.length; i += DESCRIBE_CONCURRENCY) {
    const settled = await Promise.all(
      hits.slice(i, i + DESCRIBE_CONCURRENCY).map(async (hit) => {
        try {
          return await describe(hit);
        } catch {
          return null;
        }
      }),
    );
    for (const device of settled) if (device) out.push(device);
  }
  return out;
}

/**
 * 拉一份设备描述，把它变成一台可投设备。
 * ★ 找不到 `AVTransport` 就回 null（那不是媒体渲染器，投不了）。
 */
export async function describe(hit: SsdpHit): Promise<CastDevice | null> {
  const text = await fetchText(hit.location, DESCRIBE_TIMEOUT_MS);
  if (!text) return null;
  const parsed = parseDescription(text, hit.location);
  if (!parsed) return null;
  return {
    id: parsed.udn || hit.usn || hostOf(hit.location),
    name: parsed.friendlyName || parsed.modelName || hostOf(hit.location),
    protocol: 'dlna',
    model: parsed.modelName,
    address: hit.address || hostOf(hit.location),
    controlUrl: parsed.controlUrl,
    serviceType: parsed.serviceType,
  };
}

// ---------------------------------------------------------------- 控制

/** `SetAVTransportURI` + `Play` —— 投一个地址过去并开始播 */
export async function dlnaCast(device: CastDevice, url: string, title: string): Promise<void> {
  try {
    await soap(device, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: url,
      CurrentURIMetaData: buildMetadata(url, title),
    });
  } catch (err) {
    // ★★ 从宽：很多电视不接受 DIDL 元数据（甚至会被噎住）—— 去掉再试一次
    try {
      await soap(device, 'SetAVTransportURI', {
        InstanceID: '0',
        CurrentURI: url,
        CurrentURIMetaData: '',
      });
    } catch {
      throw err;
    }
  }
  await dlnaPlay(device);
}

export async function dlnaPlay(device: CastDevice): Promise<void> {
  await soap(device, 'Play', { InstanceID: '0', Speed: '1' });
}

export async function dlnaPause(device: CastDevice): Promise<void> {
  await soap(device, 'Pause', { InstanceID: '0' });
}

export async function dlnaStop(device: CastDevice): Promise<void> {
  await soap(device, 'Stop', { InstanceID: '0' });
}

export async function dlnaSeek(device: CastDevice, seconds: number): Promise<void> {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  await soap(device, 'Seek', {
    InstanceID: '0',
    Unit: 'REL_TIME',
    Target: `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
  });
}

export async function dlnaSetVolume(device: CastDevice, percent: number): Promise<void> {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  await soap(device, 'SetVolume', {
    InstanceID: '0',
    Channel: 'Master',
    DesiredVolume: String(value),
  });
}

/**
 * 问一次播放状态与进度。
 *
 * ★ 两个查询**各自容错**：`GetTransportInfo` 成功但 `GetPositionInfo` 不支持的
 *   设备很常见（很多盒子回 `NOT_IMPLEMENTED`）。**不许因为一个失败就整条失败**，
 *   否则遥控器会整个没反应。
 */
export async function dlnaStatus(device: CastDevice): Promise<CastTransportState> {
  let state: CastTransportState['state'] = 'unknown';
  let positionSec: number | null = null;
  let durationSec: number | null = null;

  try {
    const info = await soap(device, 'GetTransportInfo', { InstanceID: '0' });
    state = normalizeState(tagOf(info, 'CurrentTransportState'));
  } catch {
    // 问不到就保持 unknown
  }
  try {
    const info = await soap(device, 'GetPositionInfo', { InstanceID: '0' });
    positionSec = parseRel(tagOf(info, 'RelTime'));
    durationSec = parseRel(tagOf(info, 'TrackDuration'));
  } catch {
    // 同上
  }

  return { state, positionSec, durationSec };
}

// ---------------------------------------------------------------- SOAP

/**
 * 发一次 SOAP 调用，返回响应正文。
 * ★ 失败时**换一种 `SOAPACTION` 写法重试**：规范要带引号，但见过只认不带引号的
 *   老设备。两种都试，成本只是一次请求。
 */
export async function soap(
  device: CastDevice,
  action: string,
  args: Record<string, string>,
): Promise<string> {
  if (!device.controlUrl) throw new Error('这台设备没有 AVTransport 控制地址');
  const serviceType = device.serviceType || DEFAULT_SERVICE;
  const body = buildEnvelope(serviceType, action, args);

  let lastError: unknown = null;
  for (const header of [`"${serviceType}#${action}"`, `${serviceType}#${action}`]) {
    try {
      return await postSoap(device.controlUrl, header, body);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${action} 调用失败`);
}

async function postSoap(url: string, soapAction: string, body: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOAP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: soapAction,
        // ★ 不带 Referer / Origin：部分设备的 mini-web 会因此拒绝
        Accept: 'text/xml, application/xml, */*',
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    // ★ 不看 HTTP 状态码：失败时也回 200 的设备很多，错误藏在 Fault 里；
    //   反过来也有回 500 但其实干成了的。**以正文为准**。
    const fault = faultOf(text);
    if (fault) throw new Error(fault);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 工具

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/xml, application/xml, */*' },
      signal: controller.signal,
    });
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 抠标签文本。★ 放在这里而不是 import `xml`，是为了让调用点少一行 import */
function tagOf(xml: string, tag: string): string {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`,
    'i',
  ).exec(xml);
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : '';
}

function parseRel(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[4] ? Number.parseFloat(`0.${match[4]}`) : 0;
  return (
    Number.parseInt(match[1], 10) * 3600 +
    Number.parseInt(match[2], 10) * 60 +
    Number.parseInt(match[3], 10) +
    fraction
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 纯逻辑那几个顺手转出去，调用方不用记两个文件
export {
  AVTRANSPORT,
  buildMetadata,
  faultOf,
  normalizeState,
  parseDescription,
  resolveUrl,
};
export { parseRelTime, toRelTime } from './xml';
