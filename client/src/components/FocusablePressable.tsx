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
import React, { useState } from 'react';
import { Pressable as RNPressable } from 'react-native';
import type { PressableProps, ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { useRemoteMode } from '../tv/inputMode';

export function Pressable({
  style,
  onFocus,
  onBlur,
  ...rest
}: PressableProps): React.JSX.Element {
  const { color } = useTheme();
  const remote = useRemoteMode();
  const [focused, setFocused] = useState(false);

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
      onFocus={event => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={event => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={state => [
        typeof style === 'function' ? style(state) : style,
        focused && remote ? ring : null,
      ]}
    />
  );
}
