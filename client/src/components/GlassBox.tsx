import React from 'react';
import { Platform, StyleSheet, UIManager, View, requireNativeComponent } from 'react-native';
import type {
  NativeSyntheticEvent,
  StyleProp,
  ViewProps,
  ViewStyle,
} from 'react-native';

import { radius as radiusScale, useTheme } from '../theme';

interface Props {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 圆角，默认跟主题的 radius.lg */
  cornerRadius?: number;
  /** 强制开 / 关玻璃；不传就跟随设置里的开关 */
  enabled?: boolean;
  /**
   * 真·液态玻璃的**交互态**：按住玻璃会扩张 + 起高光（系统 Tab 栏那个手感）。
   *
   * ★ 只有 iOS 26+ 有真玻璃（`UIGlassEffect`），低版本这参数是**空操作** ——
   *   玻璃照旧静态，命中行为也跟从前完全一样。所以调用方可以放心传。
   * ★ 开了之后玻璃会**重新参与命中测试**（不参与就收不到触摸，也就不会动）。
   *   children 由 GlassBox 作为 React 兄弟层放在玻璃上方，保证 RN 交互稳定。
   */
  interactive?: boolean;
  /**
   * ★ 原生拖动转发（只给 Tab 栏的每一格开）。
   *
   *   交互玻璃会 cancel RN 的触摸流，拖动事件得从原生那边送回来：
   *   原生 `UIPanGestureRecognizer` 把 `translationX` 通过 `onPan` 发给 JS，
   *   胶囊/页面的跟手逻辑照旧在 JS 里跑。
   */
  panEnabled?: boolean;
  onPan?: (e: NativeSyntheticEvent<NativePanEvent>) => void;
  onTouchStart?: ViewProps['onTouchStart'];
  onTouchEnd?: ViewProps['onTouchEnd'];
  onTouchCancel?: ViewProps['onTouchCancel'];
}

export interface NativePanEvent {
  /** 0=began 1=changed 2=ended 3=cancelled */
  state: number;
  translationX: number;
  translationY: number;
}

type NativeGlassProps = ViewProps & {
  cornerRadius?: number;
  glassStyle?: string;
  interactive?: boolean;
  panEnabled?: boolean;
  onPan?: (e: NativeSyntheticEvent<NativePanEvent>) => void;
};

const FILL: ViewStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

/**
 * 原生玻璃视图装上了没。装不上就退回纯色面板，不会白屏。
 *
 * ★★ 这里**必须用 `hasViewManagerConfig`，不能用 `getViewManagerConfig`**。
 *   新架构（本项目 newArchEnabled=true）下 `getViewManagerConfig` 拿的是
 *   **原生 ViewConfig**，而 interop 层没开时它直接返回 null ——
 *   于是检测恒为 false，玻璃被**静默降级**成纯色面板，什么错都不报。
 *   RN 自己的提示写得很明白：
 *     "If you want to see if this component is registered with React Native,
 *      please call hasViewManagerConfig('X') instead."
 *   （`hasViewManagerConfig` 是 0.74+ 才有的，所以老版本回退到旧 API。）
 */
function hasNativeGlass(): boolean {
  if (Platform.OS === 'web') return false;
  const ui = UIManager as unknown as {
    hasViewManagerConfig?: (name: string) => boolean;
    getViewManagerConfig?: (name: string) => unknown;
  };
  try {
    if (typeof ui.hasViewManagerConfig === 'function') {
      return ui.hasViewManagerConfig('GlassView');
    }
    return Boolean(ui.getViewManagerConfig?.('GlassView'));
  } catch {
    return false;
  }
}

/**
 * 原生玻璃视图在当前平台 / 架构下**是否真的注册上了**。
 *
 * ★ 模块加载时探一次（原生注册状态不会变），App 层也要用它 ——
 *   Tab 栏垫在玻璃背后的底色按"有没有玻璃"选：
 *   有玻璃 → 用透光底 `color.bar`；没有 → 退回 `color.barSolid`，
 *   否则没有模糊兜着，文字会在海报上糊没。
 */
export const NATIVE_GLASS_AVAILABLE = hasNativeGlass();

/**
 * 本机能不能拿到**真·液态玻璃**（iOS 26 的 `UIGlassEffect`）。
 *
 * ★ 这是运行系统版本，不是编译 SDK 版本 —— 两条路都要有：
 *   iOS 26 上给真材质（折射 + 边缘高光 + 按住会动），
 *   15.1 ~ 25 上退回原来的模糊近似。
 * ★ 真玻璃是**自己会折光**的材质，背后不能再垫一层半透明黑 ——
 *   那层会被材质一并采样，玻璃就糊了。所以 App 层要靠这个标志决定
 *   Tab 栏的底色用 `transparent` 还是 `color.bar`。
 */
export const LIQUID_GLASS_AVAILABLE =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

const NativeGlass = NATIVE_GLASS_AVAILABLE
  ? requireNativeComponent<NativeGlassProps>('GlassView')
  : null;

/**
 * 跨端"液态玻璃"容器。
 *
 * - **iOS**：原生 `UIVisualEffectView` —— iOS 26+ 是真 `UIGlassEffect`，
 *   低版本是真背景模糊 + 上缘高光 + 描边
 * - **Android**：纵向渐变底 + 上缘高光 + 描边的高质量近似。
 *   Android 上拿不到真正的背景模糊（`RenderEffect` 糊的是自己，
 *   `Window.setBackgroundBlurRadius` 只对整个窗口生效），详见 `GlassView.kt`
 *
 * ★ 默认玻璃层永远 `pointerEvents="none"`，只做背景，不参与命中测试 ——
 *   否则会把底下的手势层和上面的按钮都挡掉。
 *   例外是 `interactive`（见下）。
 */
export function GlassBox({
  children,
  style,
  cornerRadius,
  enabled,
  interactive,
  panEnabled,
  onPan,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
}: Props): React.JSX.Element {
  const { color, glass } = useTheme();
  const corner = cornerRadius ?? radiusScale.lg;
  const on = (enabled ?? glass) && NativeGlass !== null;
  const glassStyle = color.statusBar === 'dark-content' ? 'light' : 'dark';

  /**
   * ★★ 交互玻璃（iOS 26+ 真材质）——**层级必须照 Apple 官方的来**。
   *
   *   Apple 文档《Implementing Liquid Glass Design in UIKit》里那个
   *   "带自定义内容 + 可交互" 的玻璃卡片例子是这么摆的：
   *
   *       CardView
   *       ├─ effectView(玻璃)
   *       └─ contentView(React 内容)
   *
   *   当前 RN 原生桥接下，React 内容作为 GlassView 的兄弟层放置，
   *   由 GlassBox 保持稳定的命中和布局行为。
   *
   *   低版本系统没有真玻璃，`interactive` 是空操作 —— 仍旧走静态兜底，
   *   行为与从前完全一致。
   */
  const pressable = Boolean(interactive) && on && LIQUID_GLASS_AVAILABLE;

  return (
    <View style={style}>
      {on && NativeGlass ? (
        <NativeGlass
          style={FILL}
          cornerRadius={corner}
          glassStyle={glassStyle}
          interactive={pressable || undefined}
          panEnabled={panEnabled || undefined}
          onPan={onPan}
          pointerEvents={pressable ? 'auto' : 'none'}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
        />
      ) : (
        <View
          pointerEvents="none"
          style={[
            FILL,
            {
              borderRadius: corner,
              backgroundColor: color.surface,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: color.border,
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}
