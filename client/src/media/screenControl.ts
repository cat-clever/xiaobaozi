/**
 * 播放页要用的系统能力（亮度 / 方向）。
 *
 * 原生模块不在时静默降级 —— 手势照旧能用，只是不改系统亮度、不自动转屏。
 */
import { NativeModules } from 'react-native';

export type OrientationMode = 'landscape' | 'portrait' | 'auto';

interface ScreenControlNative {
  setBrightness(value: number): Promise<void>;
  setOrientation(mode: OrientationMode): Promise<void>;
  /** 按视频宽高比设置画中画窗口（Android 需要；iOS 是空实现） */
  setPipAspectRatio(width: number, height: number): Promise<void>;
}

const native = (NativeModules as Record<string, unknown>).ScreenControl as
  | ScreenControlNative
  | undefined;

export const isScreenControlAvailable = (): boolean => !!native;

export function applyBrightness(value: number): void {
  void native
    ?.setBrightness(Math.max(0, Math.min(1, value)))
    .catch(() => undefined);
}

export function applyOrientation(mode: OrientationMode): void {
  void native?.setOrientation(mode).catch(() => undefined);
}

/**
 * 把画中画窗口的形状对齐到视频的宽高比。
 *
 * ★ 不设的话画中画窗口是默认形状，视频两侧留白（源码里那条"上滑自动进入"
 *   的路径不设 `setAspectRatio`，只设了 autoEnter）。
 * 视频元数据到手后调一次即可。
 */
export function setPipAspectRatio(width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  void native?.setPipAspectRatio(width, height).catch(() => undefined);
}
