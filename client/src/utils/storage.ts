/**
 * 本地持久化。
 *
 * 设备号必须持久化：源2 上游**按设备号把 CDN 节点钉死**，
 * 每次启动换号会重新随机分节点，大概率掉到慢的 http 节点。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RAND_CHARS, UID_RE } from '../api/source2/constants';
import { randUid } from '../api/source2/crypto';

const KEY_DEVICE_UID = 'baozivideo.deviceUid';
const KEY_UID_SLOW_HITS = 'baozivideo.deviceUid.slowHits';
const KEY_SEARCH_HISTORY = 'baozivideo.searchHistory';
const KEY_HISTORY = 'baozivideo.watchHistory';

/**
 * 连着几次分到慢节点就换号。
 *
 * 取 2 而不是 1：单次拿到 http 也可能是**这部剧本身**只有 http 源，
 * 连着两次才更像是"这个设备号被钉在了 piccc 上"。
 */
export const SLOW_HITS_BEFORE_ROTATE = 2;

/**
 * 这次启动要不要换一个新设备号。纯函数，方便单测。
 *
 * @param saved    上次落盘的设备号（null = 没有）
 * @param slowHits 连续分到慢节点的次数
 */
export function shouldRotateDeviceUid(saved: string | null, slowHits: number): boolean {
  // 没有 / 格式不对 → 必须生成一个（只认 20 位 [0-9A-Za-z]，与上游一致）
  if (!saved || !UID_RE.test(saved)) return true;
  return slowHits >= SLOW_HITS_BEFORE_ROTATE;
}

/**
 * 取设备号。
 *
 * ★ 换号策略是**两头都不能走极端**：
 *
 *   - 每次都换号 → 上游按设备号钉 CDN 节点，每次启动都重新随机分，
 *     节点永远不稳；
 *   - 永远不换号 → 首次请求随机分到慢的 http 节点（piccc）就**永久慢**
 *     （实测：同一个号换多少 IP 都分到同一个节点，改不回来）。
 *
 *   折中：**一直慢就记一笔（`notePlayNode`），下次启动换新号** ——
 *   等于重新掷一次骰子。全新的号约 1/4 分到快的 https 节点（voldn-ser01）。
 */
export async function getDeviceUid(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(KEY_DEVICE_UID);
    const slowHits = Number((await AsyncStorage.getItem(KEY_UID_SLOW_HITS)) ?? 0);
    if (!shouldRotateDeviceUid(saved, slowHits)) return saved as string;
  } catch {
    // 读失败就现生成一个，不阻塞启动
  }

  const fresh = randUid(RAND_CHARS);
  try {
    await AsyncStorage.setItem(KEY_DEVICE_UID, fresh);
    // 换了号就把计数清零，新号从零开始算
    await AsyncStorage.setItem(KEY_UID_SLOW_HITS, '0');
  } catch {
    // 落盘失败也能用，只是下次启动会换号
  }
  return fresh;
}

/**
 * 记一笔：这次播放分到的节点快不快。
 *
 * 由 `s2.playFor()` 在拿到播放地址后调用 —— 拿到 https 就清零，
 * 拿到 http（piccc）就累加。累加到阈值，**下次启动** `getDeviceUid()` 会换新号。
 */
export async function notePlayNode(hasHttps: boolean): Promise<void> {
  try {
    if (hasHttps) {
      await AsyncStorage.setItem(KEY_UID_SLOW_HITS, '0');
      return;
    }
    const hits = Number((await AsyncStorage.getItem(KEY_UID_SLOW_HITS)) ?? 0) + 1;
    await AsyncStorage.setItem(KEY_UID_SLOW_HITS, String(hits));
  } catch {
    // 记不上就算了，不影响播放
  }
}

const KEY_THEME = 'baozivideo.theme';

export interface StoredTheme {
  mode: 'dark' | 'light' | 'system';
  glass: boolean;
}

/** 读主题设置。没存过返回 null，交给调用方用默认值 */
export async function getThemeSettings(): Promise<StoredTheme | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_THEME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTheme>;
    const mode = parsed.mode;
    return {
      mode: mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system',
      // 只有显式存了 false 才算关 —— 没存过默认开
      glass: parsed.glass !== false,
    };
  } catch {
    return null;
  }
}

export async function saveThemeSettings(settings: StoredTheme): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_THEME, JSON.stringify(settings));
  } catch {
    // 存不上就这次生效，下次启动回默认
  }
}

const KEY_MINI_SIZE = 'baozivideo.miniSize';

/**
 * 应用内小窗的档位（0 小 / 1 中 / 2 大）。
 *
 * ★ 存起来是为了"下次收小窗还是上次那档" —— 小窗是随手收出来的，
 *   每次都要重新调一遍大小太烦。
 *
 * @returns 没存过 / 值不可信时返回 null，交给调用方用默认档
 */
export async function getMiniSizeIdx(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_MINI_SIZE);
    if (raw === null) return null;
    const n = Number(raw);
    // 只认非负整数；超出当前档位数的由调用方夹回来（档位将来可能变多）
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export async function saveMiniSizeIdx(idx: number): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_MINI_SIZE, String(idx));
  } catch {
    // 存不上就这次生效
  }
}

export async function getSearchHistory(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SEARCH_HISTORY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function pushSearchHistory(keyword: string): Promise<string[]> {
  const list = await getSearchHistory();
  const next = [keyword, ...list.filter((k) => k !== keyword)].slice(0, 20);
  try {
    await AsyncStorage.setItem(KEY_SEARCH_HISTORY, JSON.stringify(next));
  } catch {
    // 忽略
  }
  return next;
}

export async function clearSearchHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_SEARCH_HISTORY);
  } catch {
    // 忽略
  }
}

export interface WatchRecord {
  id: string;
  sourceId: 's1' | 's2';
  title: string;
  cover: string;
  episodeIndex: number;
  positionSec: number;
  updatedAt: number;
}

export async function getWatchHistory(): Promise<WatchRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_HISTORY);
    return raw ? (JSON.parse(raw) as WatchRecord[]) : [];
  } catch {
    return [];
  }
}

/** 记录观看进度（断点记忆） */
export async function saveWatchRecord(record: WatchRecord): Promise<void> {
  const list = await getWatchHistory();
  const next = [record, ...list.filter((r) => r.id !== record.id)].slice(0, 100);
  try {
    await AsyncStorage.setItem(KEY_HISTORY, JSON.stringify(next));
  } catch {
    // 忽略
  }
}
