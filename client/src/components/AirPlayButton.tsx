/**
 * AirPlay 的系统路由选择器（iOS）。
 *
 * ★★ **只能用系统这套**：苹果没有公开"自己发现 AirPlay 设备 / 自己发起投屏"
 *   的 API。第三方 App 一律是把 `AVRoutePickerView` 摆出来，由系统弹路由列表
 *   （Apple TV、支持 AirPlay 2 的电视…）。想自绘一个列表再投过去，iOS 上做不到。
 *
 * ★ 真正让画面走 AirPlay 的是播放器那侧的 `allowsExternalPlayback`
 *   （`react-native-video` 的 prop，见 `PlayerScreen`）—— 这个按钮只负责**让用户挑设备**。
 *
 * ★ 非 iOS / 原生视图没注册上时**渲染 null**，调用方不用自己判平台。
 */
import React from 'react';
import {
  Platform,
  StyleSheet,
  UIManager,
  View,
  requireNativeComponent,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { useTheme } from '../theme';

interface NativeProps {
  style?: StyleProp<ViewStyle>;
  iconColor?: string;
  activeIconColor?: string;
  prioritizesVideoDevices?: boolean;
}

/**
 * ★ 用 `hasViewManagerConfig`，**不能用** `getViewManagerConfig` ——
 *   新架构下后者拿的是原生 ViewConfig，interop 没开时返回 null，
 *   检测恒为 false，按钮会**静默消失**。跟 `GlassBox` 那边同一个坑。
 */
function hasNative(): boolean {
  if (Platform.OS !== 'ios') return false;
  const ui = UIManager as unknown as {
    hasViewManagerConfig?: (name: string) => boolean;
    getViewManagerConfig?: (name: string) => unknown;
  };
  try {
    if (typeof ui.hasViewManagerConfig === 'function') {
      return ui.hasViewManagerConfig('AirPlayButton');
    }
    return Boolean(ui.getViewManagerConfig?.('AirPlayButton'));
  } catch {
    return false;
  }
}

export const AIRPLAY_AVAILABLE = hasNative();

/**
 * ★★ 名字是 **`AirPlayButton`**，不是 `AirPlayButtonView`。
 *   RN 的视图管理器注册名 = **类名去掉 `Manager`**（`AirPlayButtonManager`
 *   -> `AirPlayButton`），跟原生那个 View 类叫什么无关
 *   （`GlassViewManager` -> `GlassView` 是同一个规矩）。
 *   写成 `...View` 的话 `hasViewManagerConfig` 恒为 false，按钮**静默消失**。
 */
const NativeAirPlayButton = AIRPLAY_AVAILABLE
  ? requireNativeComponent<NativeProps>('AirPlayButton')
  : null;

interface Props {
  style?: StyleProp<ViewStyle>;
}

export function AirPlayButton({ style }: Props): React.JSX.Element | null {
  const { color } = useTheme();
  if (!NativeAirPlayButton) return null;
  return (
    <View style={[styles.wrap, style]}>
      <NativeAirPlayButton
        style={styles.fill}
        iconColor={color.text}
        activeIconColor={color.accent}
        prioritizesVideoDevices
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  fill: StyleSheet.absoluteFill,
});
