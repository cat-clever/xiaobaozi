/**
 * 视觉常量与两套配色。
 *
 * ★ 间距和圆角是**跨主题不变**的，直接静态导出；
 *   颜色随主题变，一律从 `useTheme()` 拿（见 `./ThemeContext`）。
 *   写死的 `theme.color.x` 会让亮色主题切不动。
 */
import { Platform } from 'react-native';

export interface Palette {
  /** 页面底色 */
  bg: string;
  /** 卡片 / 胶囊的填充 */
  surface: string;
  /** 强调一档的填充（选中态） */
  surfaceStrong: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  danger: string;
  /** 压在图片上的遮罩 */
  scrim: string;

  /**
   * 卡片左上角**来源角标**的底色 / 字色。
   *
   * ★ 两个源必须**颜色不同**才叫"一眼看出是哪个源"。
   *   原来两边都是半透明黑胶囊 + 10pt 白字，长得一模一样 ——
   *   搜索结果里两源的卡混在一起时根本分不清（用户实测反馈 2026-10-16）。
   *
   *   所以：精选源（s2）用主题橙跳出来，全网源（s1）用高对比黑胶囊。
   */
  badgeS1: string;
  badgeS1Text: string;
  badgeS2: string;
  badgeS2Text: string;

  /** —— 液态玻璃层用的三个色 —— */
  /** 玻璃底色 */
  glass: string;
  /** 玻璃描边 */
  glassBorder: string;
  /** 玻璃上缘的高光（"折射"感就靠它） */
  glassHighlight: string;

  /**
   * 底部 Tab 栏**垫在玻璃层后面**的透光底（玻璃开启时用）。
   *
   * ★ 它必须够透。玻璃层是对着"背后的内容"干活的 ——
   *   iOS 的模糊要糊它、Android 的渐变要透它；底要是接近不透明，
   *   玻璃背后就成了一片纯色：iOS 没东西可糊、Android 没光可透，
   *   两端都会退化成一块纯色板（表现为"完全没有玻璃效果"）。
   *
   * 但也不能像没底一样透 —— 底下压着海报图时文字会读不出来。
   * 所以按平台分开给：
   *   - iOS 有**真背景模糊**，模糊本身就把内容的明暗拉平了，底可以更透；
   *   - Android 没有背景模糊，底要更实一点，靠它兜住文字对比度。
   */
  bar: string;
  /**
   * 底部 Tab 栏的底（**玻璃关闭 / 原生玻璃不可用**时用）。
   * 这时背后没有玻璃兜着，必须退回接近不透明的底，保证文字可读。
   */
  barSolid: string;

  /** 状态栏文字该用亮色还是暗色 */
  statusBar: 'light-content' | 'dark-content';
}

/** 深色（默认） */
export const DARK: Palette = {
  bg: '#0B0B0F',
  surface: 'rgba(255,255,255,0.06)',
  surfaceStrong: 'rgba(255,255,255,0.10)',
  border: 'rgba(255,255,255,0.12)',
  text: '#F2F2F7',
  textDim: 'rgba(242,242,247,0.62)',
  textFaint: 'rgba(242,242,247,0.38)',
  accent: '#FFB454',
  danger: '#FF6B6B',
  scrim: 'rgba(0,0,0,0.55)',
  // 精选源 = 主题橙配深字（对比度约 10:1）；全网源 = 黑胶囊配白字
  badgeS1: 'rgba(0,0,0,0.78)',
  badgeS1Text: '#FFFFFF',
  badgeS2: '#FFB454',
  badgeS2Text: '#241503',
  glass: 'rgba(255,255,255,0.10)',
  glassBorder: 'rgba(255,255,255,0.22)',
  glassHighlight: 'rgba(255,255,255,0.42)',
  // 深色：iOS 0.50（有真模糊） / Android 0.66（没模糊，留多点底）
  bar: Platform.OS === 'ios' ? 'rgba(16,16,22,0.50)' : 'rgba(16,16,22,0.66)',
  barSolid: 'rgba(16,16,22,0.88)',
  statusBar: 'light-content',
};

/**
 * 亮色。
 *
 * 注意两处跟深色不是简单反色的地方：
 *   - `accent` 压暗了一档 —— 原来那个亮橙放在浅底上对比度不够，看不清
 *   - `surface` 用黑而不是白 —— 浅底上再叠白就看不见了
 */
export const LIGHT: Palette = {
  bg: '#F6F6F9',
  surface: 'rgba(0,0,0,0.045)',
  surfaceStrong: 'rgba(0,0,0,0.085)',
  border: 'rgba(0,0,0,0.12)',
  text: '#141418',
  textDim: 'rgba(20,20,24,0.64)',
  textFaint: 'rgba(20,20,24,0.40)',
  accent: '#D97516',
  danger: '#D23B3B',
  scrim: 'rgba(0,0,0,0.38)',
  // 精选源 = 主题橙配深字（对比度约 5.6:1）；全网源 = 近黑胶囊配白字
  badgeS1: 'rgba(20,20,24,0.84)',
  badgeS1Text: '#FFFFFF',
  badgeS2: '#D97516',
  badgeS2Text: '#241503',
  glass: 'rgba(255,255,255,0.52)',
  glassBorder: 'rgba(255,255,255,0.80)',
  glassHighlight: 'rgba(255,255,255,0.95)',
  // 亮色：白字底反过来 —— iOS 0.60（有真模糊） / Android 0.75（没模糊）
  bar: Platform.OS === 'ios' ? 'rgba(255,255,255,0.60)' : 'rgba(255,255,255,0.75)',
  barSolid: 'rgba(255,255,255,0.90)',
  statusBar: 'dark-content',
};

export type ThemeMode = 'dark' | 'light' | 'system';

export const radius = { sm: 8, md: 14, lg: 22, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/**
 * 悬浮 Tab 栏占掉的高度（含它离底边留的那点距离）。
 * 各页面的列表底部要留出这么多，否则最后一行会被 Tab 栏压住。
 */
export const TAB_BAR_SPACE = 92;

export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeSettings } from './ThemeContext';
