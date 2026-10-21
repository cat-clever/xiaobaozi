/**
 * 带**遥控器焦点环**的 `Pressable`。
 *
 * ★ 焦点环只在**真的获得焦点**时出现：
 *   - Android 上触摸不会给 focusable 的 View 焦点（RN 的 BaseViewManager
 *     把 `focusableInTouchMode` 强制成 false），所以手机正常触摸不会出现焦点框；
 *   - 只有电视遥控器 / 键盘方向键才会让 View 获得焦点。
 *   这正好满足"没有遥控器介入就不显示聚焦样式"。
 *
 * 用法：把 `import { Pressable } from 'react-native'` 换成
 * `import { Pressable } from '.../FocusablePressable'` 即可，其余 props 不变。
 */
import React, { useCallback, useRef, useState } from 'react';
import { Pressable as RNPressable } from 'react-native';
import type { PressableProps, ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { isRemoteMode, useRemoteMode } from '../tv/inputMode';

/**
 * ★ 遥控器按键防抖间隔（毫秒）。
 *
 * 即使原生层已经过滤了 repeatCount > 0 的按键事件（见 MainActivity.kt），
 * 有些盒子的遥控器/蓝牙遥控器仍然可能在极短间隔内发出多次独立的 ACTION_DOWN
 * （repeatCount 均为 0）。300ms 足以挡住这类抖动，又不会让正常操作感觉迟钝。
 */
const TV_PRESS_DEBOUNCE_MS = 150;

export const Pressable = React.forwardRef<
  React.ElementRef<typeof RNPressable>,
  PressableProps
>(function Pressable({ style, onFocus, onBlur, onPress, ...rest }, ref) {
  const { color } = useTheme();
  const remote = useRemoteMode();
  const [focused, setFocused] = useState(false);

  /**
   * ★ 遥控器模式下给 onPress 加防抖 —— 上一次触发后 300ms 内的再次触发直接丢弃。
   *   这是"Tab 跳两格 / 设置页快速跳 / 播放器焦点乱跳"的第二道保险。
   *   触摸模式不受影响。
   */
  const lastPressRef = useRef(0);
  const debouncedOnPress = useCallback(
    (e: Parameters<NonNullable<PressableProps['onPress']>>[0]) => {
      if (isRemoteMode()) {
        const now = Date.now();
        if (now - lastPressRef.current < TV_PRESS_DEBOUNCE_MS) return;
        lastPressRef.current = now;
      }
      onPress?.(e);
    },
    [onPress],
  );

  // outline 不占布局（RN 0.76+ 支持），不会把按钮撑大/挤歪
  const ring: ViewStyle = {
    outlineWidth: 3,
    outlineColor: color.accent,
    outlineStyle: 'solid',
    outlineOffset: 2,
  };

  return (
    <RNPressable
      {...rest}
      ref={ref}
      onFocus={event => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={event => {
        setFocused(false);
        onBlur?.(event);
      }}
      onPress={onPress ? debouncedOnPress : undefined}
      style={state => [
        typeof style === 'function' ? style(state) : style,
        focused && remote ? ring : null,
      ]}
    />
  );
});

