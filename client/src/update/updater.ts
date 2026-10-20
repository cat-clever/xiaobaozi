/**
 * OTA 升级的运行时：拉清单、比版本、下载安装。
 *
 * ★★ 两端能做到的事**根本不一样**，别写成一套：
 *   - **Android**：APK 是**固定签名**的（密钥随仓库提交，见 `android/key.properties`），
 *     所以可以"下载 -> 交给系统安装器覆盖安装"。这是**真·端内升级**，
 *     用户数据都留着，不用先卸载。
 *   - **iOS**：IPA 是**未签名**的，系统不允许 App 自己装自己 ——
 *     没有合法的自更新路径（越狱 / 企业证书 / TestFlight 都不适用）。
 *     所以 iOS 只做到"发现新版本 + 把你送过去"：打开发布页，或用 SideStore 更新源。
 *     这不是偷懒，是平台限制。
 *
 * ★ 状态放**模块级**而不是组件 state：App 启动时静默查一次、设置页打开时读同一份，
 *   两边结论必须一致（不能一个说有新版、一个说没有）。
 */
import { useSyncExternalStore } from 'react';
import {
  Linking,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';

import {
  canCompare,
  hasUpdate,
  normalizeCurrentVersion,
  parseManifest,
} from './manifest';
import type { CurrentVersion, UpdateManifest } from './manifest';

const REPO = 'cat-clever/xiaobaozi';

/** 永远指向最新那次 release 的发布页 */
export const RELEASE_PAGE_URL = `https://github.com/${REPO}/releases/latest`;

/**
 * 清单地址。
 *
 * ★ 挂在 `releases/latest/download/` 上：每次发版 CI 都会覆盖这个资产名，
 *   所以 JS 侧不用跟着版本号改。
 * ★ 但这条是 **CDN 直链**，刚发完版可能还在回旧内容 —— 取的时候必须带
 *   时间戳参数绕缓存（见 `fetchManifest`）。
 */
export const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;

/** SideStore 更新源（iOS 上真正能"升级"的路子） */
export const SIDESTORE_SOURCE_URL = `https://github.com/${REPO}/releases/latest/download/xiaobaozi.json`;

/** 原生升级模块报上来的字段名（见 `normalizeCurrentVersion` 的说明） */
interface UpdaterNative {
  getVersion(): Promise<unknown>;
  downloadAndInstall(url: string): Promise<string>;
}

const native = (NativeModules as Record<string, unknown>).Updater as
  | UpdaterNative
  | undefined;

export const isUpdaterAvailable = (): boolean =>
  Platform.OS === 'android' && !!native;

/** 下载进度的事件通道。原生模块不存在时为 null */
export const updaterEvents: NativeEventEmitter | null = native
  ? new NativeEventEmitter(native as never)
  : null;

export const UPDATE_PROGRESS_EVENT = 'updaterProgress';

export interface UpdateProgressEvent {
  /** 已下载字节数 */
  received: number;
  /** 总字节数（服务端没给 Content-Length 时是 0） */
  total: number;
}

export interface UpdateState {
  /** 本机装的版本；`null` = 还没问到（原生模块缺失 / 还没查过） */
  current: CurrentVersion | null;
  phase: 'idle' | 'checking' | 'latest' | 'available' | 'error';
  /** 有新版时的清单 */
  manifest: UpdateManifest | null;
  /** 出错时给用户看的短句 */
  error: string | null;
  /** 下载进度 0..1；`null` = 没在下载 */
  progress: number | null;
  /** 下载完、已经唤出系统安装器 */
  installing: boolean;
}

let state: UpdateState = {
  current: null,
  phase: 'idle',
  manifest: null,
  error: null,
  progress: null,
  installing: false,
};

const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

export const getUpdateState = (): UpdateState => state;

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 侧订阅：App 顶部的提示点、设置页共用同一份状态 */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
}

let versionPromise: Promise<CurrentVersion | null> | null = null;

/**
 * 问一次原生：这台机器装的是哪一版。
 *
 * ★★ 原生的字段名是 `versionName`（两端都是），收的时候必须过
 *   `normalizeCurrentVersion` —— 只认 `version` 的话 iOS 上会拿到空串，
 *   而空串跟任何版本比都是"更旧"，结果是**永远**提示有新版。详见该函数注释。
 * ★ 不猜、不硬编码 —— 原生模块不在就返回 null，上层据此**不显示**版本号，
 *   而不是编一个出来（编错了比不显示更糟）。
 */
export function getCurrentVersion(): Promise<CurrentVersion | null> {
  if (!versionPromise) {
    versionPromise = native
      ? native
          .getVersion()
          .then(normalizeCurrentVersion)
          .catch(() => null)
      : Promise.resolve(null);
  }
  return versionPromise;
}

/**
 * 只读本机版本（纯本地，不走网络），读到就写进全局状态。
 *
 * ★★ 设置页的「当前版本」**不能等远端清单**：清单是 GitHub 请求，国内
 *   可能要等到 10 秒超时。原来 `checkForUpdate` 用 `Promise.all` 把两者
 *   绑在一起，结果就是"打开设置页很久都显示读取中…"（2026-10-20 反馈，
 *   iOS / Android 都一样）。版本号本来就是本地信息，先落地。
 */
export function loadCurrentVersion(): Promise<CurrentVersion | null> {
  return getCurrentVersion().then(current => {
    if (current) set({ current });
    return current;
  });
}

const TIMEOUT_MS = 10_000;

async function fetchManifest(): Promise<UpdateManifest | null> {
  // ★ 绕 CDN 缓存：`releases/latest/download/` 是 CDN 直链，刚发完版可能还在回旧内容，
  //   所以带一个时间戳参数（RN 的 fetch 类型里没有 `cache`，靠参数就够了）。
  const url = `${MANIFEST_URL}?t=${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseManifest(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

let inFlight: Promise<void> | null = null;

/**
 * 拉清单比版本。
 *
 * 并发调用共用同一次请求（启动时的静默检查 + 用户点"检查更新"会撞上）。
 * 不抛错 —— 结果一律落在 `state` 里，UI 读状态就行。
 */
export function checkForUpdate(): Promise<void> {
  if (inFlight) return inFlight;

  set({ phase: 'checking', error: null });

  inFlight = (async () => {
    try {
      // ★ 用 `loadCurrentVersion`：它一读到就写进 state，设置页的版本号
      //   不用等清单回来。
      const [current, manifest] = await Promise.all([
        loadCurrentVersion(),
        fetchManifest(),
      ]);

      if (!current) {
        set({
          current: null,
          manifest: null,
          phase: 'error',
          error: '拿不到本机版本号，没法比较',
        });
        return;
      }
      if (!manifest) {
        set({
          current,
          manifest: null,
          phase: 'error',
          error: '更新清单不可用（解析失败）',
        });
        return;
      }

      // ★ 版本信息不够比就**报"检查失败"**，绝不能糊成"有新版本"：
      //   那会变成每次开 App 都顶着一个假更新提示（iOS 上踩过，见 canCompare）。
      if (!canCompare(manifest, current, Platform.OS)) {
        set({
          current,
          manifest: null,
          phase: 'error',
          error: '拿不到本机版本号，没法比较',
        });
        return;
      }

      const newer = hasUpdate(manifest, current, Platform.OS);
      set({
        current,
        manifest,
        phase: newer ? 'available' : 'latest',
        error: null,
      });
    } catch (e) {
      set({
        phase: 'error',
        error: e instanceof Error && e.message ? e.message : '更新清单取不到',
      });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * 下载并安装（**只有 Android 有这条路**）。
 *
 * 失败时抛出，调用方负责把 `NEED_PERMISSION` 翻译成"先去允许安装未知应用"。
 */
export async function downloadAndInstall(url: string): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    throw new Error('本机不支持端内安装');
  }

  const sub = updaterEvents?.addListener(
    UPDATE_PROGRESS_EVENT,
    (event: unknown) => {
      const { received, total } = (event ?? {}) as UpdateProgressEvent;
      set({
        progress:
          total > 0 ? Math.min(1, Math.max(0, received / total)) : null,
      });
    },
  );

  set({ progress: 0, installing: false, error: null });

  try {
    await native.downloadAndInstall(url);
    // 系统安装器已经起来了，后面交给用户
    set({ progress: null, installing: true });
  } catch (e) {
    set({ progress: null });
    throw e;
  } finally {
    sub?.remove();
  }
}

/** 用系统浏览器打开（iOS 的"更新"就是跳发布页 / SideStore 源） */
export function openExternal(url: string): void {
  if (!url) return;
  void Linking.openURL(url).catch(() => undefined);
}
