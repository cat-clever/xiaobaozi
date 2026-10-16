/**
 * SSDP 发现的原生模块访问口。
 *
 * ★★ 原生**只做发现**（UDP 组播发 M-SEARCH、收响应），设备描述解析、
 *   `AVTransport` 查找、SOAP 控制**全在 TS**（见 `dlna.ts`）——
 *   跟文档 §6.3「协议逻辑一律留在 TS」同一个原则。
 *   好处很实在：这套逻辑能在 vitest 里单测，不用真机就能验宽松解析对不对。
 */
import { NativeModules } from 'react-native';

import type { SsdpHit } from './types';

export interface SsdpNativeModule {
  /**
   * 发现局域网设备。
   *
   * ★ 约定：**永不 reject** —— 收不到就回空数组。发现失败不该是个异常，
   *   它就是个"没找到"。
   */
  discover(timeoutMs: number): Promise<SsdpHit[]>;
}

const native = (NativeModules as Record<string, unknown>).Ssdp as
  | SsdpNativeModule
  | undefined;

export const SsdpNative = native;

/**
 * 原生发现模块装上了没。
 *
 * ★ 没装上时**只影响发现**，不影响直投 —— 用户可以手输地址那条路
 *   （`castByUrl`）照样能用。
 */
export const isSsdpAvailable = (): boolean => !!native;
