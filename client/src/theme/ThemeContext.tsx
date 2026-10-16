import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { getThemeSettings, saveThemeSettings } from '../utils/storage';
import { DARK, LIGHT } from './index';
import type { Palette, ThemeMode } from './index';

export interface ThemeSettings {
  /** 深色 / 亮色 / 跟随系统 */
  mode: ThemeMode;
  /** 液态玻璃开关 —— 关掉就退化成纯色面板 */
  glass: boolean;
}

interface ThemeValue extends ThemeSettings {
  color: Palette;
  setMode: (mode: ThemeMode) => void;
  setGlass: (on: boolean) => void;
}

const DEFAULT_SETTINGS: ThemeSettings = { mode: 'system', glass: true };

const ThemeContext = createContext<ThemeValue>({
  ...DEFAULT_SETTINGS,
  color: DARK,
  setMode: () => undefined,
  setGlass: () => undefined,
});

/**
 * 主题与液态玻璃开关。
 *
 * ★ 颜色一律从这里拿，不要在模块顶层写死 —— `StyleSheet.create` 在模块加载时
 *   就求值了，写死的话切主题不会重绘。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const systemScheme = useColorScheme();
  const [settings, setSettings] = useState<ThemeSettings>(DEFAULT_SETTINGS);

  // 启动时读一次落盘的设置
  useEffect(() => {
    let alive = true;
    void getThemeSettings().then((saved) => {
      if (alive && saved) setSettings(saved);
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback((patch: Partial<ThemeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveThemeSettings(next);
      return next;
    });
  }, []);

  const setMode = useCallback((mode: ThemeMode) => update({ mode }), [update]);
  const setGlass = useCallback((glass: boolean) => update({ glass }), [update]);

  const value = useMemo<ThemeValue>(() => {
    const effective = settings.mode === 'system' ? systemScheme ?? 'dark' : settings.mode;
    return {
      ...settings,
      color: effective === 'light' ? LIGHT : DARK,
      setMode,
      setGlass,
    };
  }, [settings, systemScheme, setMode, setGlass]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeValue => useContext(ThemeContext);
