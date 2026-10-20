/**
 * 当前是不是**遥控器/键盘**在操作。
 *
 * 原生 `InputMode` 模块在 `MainActivity.dispatchKeyEvent` 里发现方向键/确认键
 * 就报 `remote: true`，`dispatchTouchEvent` 里发现手指按下就报 `remote: false`。
 * 焦点环只在 remote 为 true 时画 —— 触摸不会出现焦点框。
 */
import { useSyncExternalStore } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';

interface InputModeNative {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const native = (NativeModules as Record<string, unknown>).InputMode as
  | InputModeNative
  | undefined;

let remote = false;
const listeners = new Set<() => void>();

function setRemote(value: boolean): void {
  if (remote === value) return;
  remote = value;
  listeners.forEach(listener => listener());
}

if (native) {
  const emitter = new NativeEventEmitter(native as never);
  emitter.addListener('inputMode', (event: { remote?: boolean }) => {
    setRemote(event.remote === true);
  });
}

export function isRemoteMode(): boolean {
  return remote;
}

export function useRemoteMode(): boolean {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isRemoteMode,
    isRemoteMode,
  );
}
