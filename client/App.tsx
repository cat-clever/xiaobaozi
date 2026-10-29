/**
 * 小包子影视 —— 应用入口。
 *
 * 导航是手写的状态机，不引 react-navigation：
 * 这个 App 只有「三个 Tab + 两级压栈 + 一个设置页」，多一个原生依赖就多一分构建风险。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  BackHandler,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
  useWindowDimensions,
} from 'react-native';
import { Pressable } from './src/components/FocusablePressable';
import type {
  GestureResponderEvent,
  LayoutChangeEvent,
  NativeSyntheticEvent,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {
  GlassBox,
  LIQUID_GLASS_AVAILABLE,
  NATIVE_GLASS_AVAILABLE,
} from './src/components/GlassBox';
import type { NativePanEvent } from './src/components/GlassBox';
import { isOnHorizontalRow } from './src/components/horizontalRow';
import { isRemoteMode } from './src/tv/inputMode';
import { CategoryScreen } from './src/screens/CategoryScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ThemeProvider, radius, space, useTheme } from './src/theme';
import type { Palette } from './src/theme';
import type { VodItem } from './src/types/schema';
import { checkForUpdate, useUpdateState } from './src/update/updater';

type Tab = 'home' | 'category' | 'search';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'category', label: '分类' },
  { id: 'search', label: '搜索' },
];

/** 悬浮 Tab 栏离底边的距离 —— 不贴底，抬上来一点 */
const TAB_BAR_BOTTOM = space.xl;

/** Tab 图标的画布边长 —— 图标本身按 22pt 左右画，留一点呼吸 */
const ICON = 26;
/**
 * 选中气泡的几何（2026-10-23 按用户给的两张状态图定）。
 *
 * ★★ 两个状态是分开的：
 *   · **静止**：气泡**收在整条里面**（纵向各内缩 `BUBBLE_INSET`），
 *     是一层很淡的灰（亮色）/ 白釉（深色），不描边、不投影；
 *   · **按下**：气泡放大（`capsuleScaleX/Y`）**涨出整条上下边**，
 *     同时叠一层亮白 + 投影（`tabBubbleLit` 的 opacity 由 `capsulePress` 驱动）。
 *
 *   横向**不外扩**（`BUBBLE_X = 0`）：静止时气泡正好是一格宽，
 *   两边不会压到相邻的格子，最左/最右也不会从整条的圆角里戳出去
 *   （用户 2026-10-23 报「胶囊左右两边静止状态下会超出 tab」）。
 *   要"探出去"只在**按下**时靠 `capsuleScale` 做。
 *   纵向涨出栏外能画出来，靠的是 `tabBar` 上的 `overflow: 'visible'`。
 */
const BUBBLE_X = 0;
const BUBBLE_INSET = 4;
/**
 * 按在离格子边界多近时，气泡**横跨相邻两格**。
 *
 * ★ 参考图里"按在两格中间"是另一种状态：气泡变成一颗盖住两格的大玻璃，
 *   两格的图标/文字一起变蓝。我们的 Tab 是相邻的两个 Pressable，
 *   所以只能靠**落点**判断：离边界 `SPAN_ZONE` 以内就算跨格。
 *   28pt 的横向留白里，边界两侧各 22pt 都算。
 */
const SPAN_ZONE = 22;

/**
 * 底部 Tab 图标 —— **纯 View 拼的**，不引 `react-native-svg`。
 *
 * ★ 为什么不引图标库：`react-native-svg` 是原生依赖，装了就得重跑 pod / gradle，
 *   而本机没有构建链（只能推 CI 验），为了三个图标把构建风险拉高不划算。
 *   三个图标都是简单几何：边框三角当屋顶、2×2 圆角方块、圆环 + 斜手柄，
 *   用 View + 圆角 + 旋转就够了，颜色直接由主题传进来。
 */
const iconStyles = StyleSheet.create({
  frame: { width: ICON, height: ICON, alignItems: 'center', justifyContent: 'center' },
  /**
   * 首页：屋顶用**边框三角**（宽 0 + 左右透明边框 + 下边框着色）。
   *
   * ★ 一开始用的是"45° 圆角方块"，26px 下会糊成一团圆顶 —— 试过预览才看出来。
   *   三角在同样尺寸下轮廓清楚得多，左右还自带一圈"屋檐"。
   */
  roof: {
    position: 'absolute',
    left: 2,
    top: 3.5,
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderBottomWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  houseBody: {
    position: 'absolute',
    left: 5,
    top: 12.5,
    width: 16,
    height: 10,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },
  // 分类：2×2 圆角方块
  gridStack: { gap: 3 },
  gridRow: { flexDirection: 'row', gap: 3 },
  gridCell: { width: 9, height: 9, borderRadius: 2.5 },
  // 搜索：圆环 + 45° 手柄（-45° 才是从左上往右下，正好接在圆环外缘）
  lens: {
    position: 'absolute',
    left: 2.5,
    top: 2.5,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.2,
  },
  handle: {
    position: 'absolute',
    left: 18.1,
    top: 14.8,
    width: 2.4,
    height: 9,
    borderRadius: 1.2,
    transform: [{ rotate: '-45deg' }],
  },
});

const TabIcon = React.memo(function TabIcon({
  name,
  color,
}: {
  name: Tab;
  color: string;
}): React.JSX.Element {
  if (name === 'home') {
    return (
      <View style={iconStyles.frame}>
        <View style={[iconStyles.roof, { borderBottomColor: color }]} />
        <View style={[iconStyles.houseBody, { backgroundColor: color }]} />
      </View>
    );
  }

  if (name === 'category') {
    return (
      <View style={iconStyles.frame}>
        <View style={iconStyles.gridStack}>
          <View style={iconStyles.gridRow}>
            <View style={[iconStyles.gridCell, { backgroundColor: color }]} />
            <View style={[iconStyles.gridCell, { backgroundColor: color }]} />
          </View>
          <View style={iconStyles.gridRow}>
            <View style={[iconStyles.gridCell, { backgroundColor: color }]} />
            <View style={[iconStyles.gridCell, { backgroundColor: color }]} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={iconStyles.frame}>
      <View style={[iconStyles.lens, { borderColor: color }]} />
      <View style={[iconStyles.handle, { backgroundColor: color }]} />
    </View>
  );
});


type Route = { name: 'tabs' } | { name: 'settings' };

/**
 * 一次播放会话。
 *
 * ★ 播放器**不做成路由**，而是一层常驻的覆盖层 ——
 *   路由切换会卸载组件树，`<Video>` 一被卸载播放就断了、小窗也就无从谈起。
 *   所以会话单独存一份状态，播放器浮在路由之上，全屏 / 小窗只是它的两种样式。
 */
interface PlaySession {
  /** 从列表点进来的那张卡片 —— 详情由播放页自己去拉 */
  item: VodItem;
  episodeIndex: number;
}

function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      {/*
        ★ `SafeAreaProvider` 提到这一层（原来在两个分支里各写了一遍）——
          好让 `AppShell` 自己就能 `useSafeAreaInsets()`：
          底部 Tab 栏的位置要按安全区抬高（见下面 `tabBarWrap` 的说明）。
      */}
      <SafeAreaProvider>
        <AppShell />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

function AppShell(): React.JSX.Element {
  const { color, glass } = useTheme();
  const { width } = useWindowDimensions();
  /**
   * 底部安全区（Home Indicator 那一条）。
   *
   * ★ 根视图的 `SafeAreaView` 已经**不吃底部**了（见那边的注释：就是它造成了
   *   「Tab 栏下面一条白条」），所以这里得自己把这段高度补回去：
   *     · Tab 栏按它抬高 —— 位置跟从前一模一样（以前是 SafeAreaView 的
   *       padding 顶上去的，现在是 `bottom` 自己算）
   *     · 各页列表底部留白也按它加高 —— 否则最后一行会压到 Home Indicator 上
   */
  const insets = useSafeAreaInsets();
  /**
   * ★ 玻璃**真的能渲染**时（设置里的开关 + 原生玻璃视图都在），
   *   Tab 栏才垫透光底 —— 否则玻璃背后没有东西可糊 / 可透，
   *   要退回接近不透明的底保证文字可读（见 `theme/index.ts` 的 bar / barSolid）。
   */
  const glassOn = glass && NATIVE_GLASS_AVAILABLE;
  /**
   * ★★ 本机能不能拿到**真·液态玻璃**，**并且用户没把玻璃关掉**。
   *
   * ★ `glassOn` 这一项**不能漏**（2026-10-16 修）：
   *   `GlassBox` 自己会看 `enabled ?? glass`，但 iOS 26 这一支用的是
   *   `LiquidGlassView` —— **它没有开关**。漏了 `glassOn` 的话，关掉玻璃后
   *   真玻璃照旧渲染，而底色已经退成 `barSolid`（0.90 不透明），
   *   表现就是"一块不透明的板压在玻璃上"（用户报的原话）。
   */
  const nativeGlass = glassOn && NATIVE_GLASS_AVAILABLE;
  /**
   * 选中气泡**本身**也铺一层原生玻璃材质。
   *
   * ★ 参考图里那颗气泡就是真玻璃（不是一块半透明色），所以这里用
   *   **非交互式**的 `GlassBox`：`interactive` 会 cancel RN 的触摸流
   *   （拖动切 Tab 就废了，见下面撤掉 per-item 玻璃的说明），
   *   非交互式那层是 `pointerEvents="none"`，只画材质、不吃手势 ——
   *   跟手滑动 / 按住放大 / 跨格撑开仍然由外层那几个 `Animated` 值驱动。
   *
   * ★ 只给 iOS：Android 的玻璃是「抓背景 + 糊 + 画」，而气泡的**宽度**
   *   在跨格/收回时是逐帧动画的 —— 每帧 `onSizeChanged` 都重抓一次全屏位图，
   *   得不偿失。Android 继续用下面那层着色近似。
   */
  const nativeBubble = glassOn && NATIVE_GLASS_AVAILABLE && Platform.OS === 'ios';
  /**
   * ★★ 每格套一层 `interactive` 原生玻璃（iOS 26 + 玻璃开启）。
   *
   *   `UIGlassEffect.isInteractive` 自带手势识别器：按住会扩张，
   *   但它同时把 RN 的触摸流 **cancel** 掉（`cancelsTouchesInView`）——
   *   "按住胶囊左右拖 = 切 Tab"在 JS 侧就收不到 move 了。
   *
   *   ★ 解法不是关掉它，而是在同一层玻璃上**再挂一个原生 pan**
   *     （`GlassView.swift` 的 `panEnabled` / `onPan`）：
   *     玻璃自己的按压动画照旧，位移由原生转给 JS，
   *     跟手 / 落位复用 `moveDrag` / `endDrag`，手感跟 Android 一致。
   *   ★ 所以这条**只给 iOS 26**：Android 的玻璃本来就不交互，走原来的 JS PanResponder。
   */
  const interactiveTabGlass =
    glassOn && Platform.OS === 'ios' && (LIQUID_GLASS_AVAILABLE as boolean);
  const styles = useMemo(
    () => makeStyles(color, glassOn, nativeGlass, insets.bottom),
    [color, glassOn, nativeGlass, insets.bottom],
  );
  const [tab, setTab] = useState<Tab>('home');
  const [route, setRoute] = useState<Route>({ name: 'tabs' });
  /**
   * ★★ TV 焦点图：三个 Tab 的 native tag。
   *
   *   只靠 Android 的空间焦点搜索时，从第二个 Tab 往右会被右上角「设置」
   *   抢走（用户 2026-10-20 真机反馈）。拿到 tag 后给 Tab 显式挂
   *   `nextFocusLeft/Right`，方向键就只会在三个 Tab 之间走。
   */
  const tabRefs = useRef<Array<React.ElementRef<typeof Pressable> | null>>([]);
  const [tabTags, setTabTags] = useState<number[]>([]);
  /**
   * ★★ 上一批算出来的 tag —— 算出来没变就不 `setState`。
   *
   *   否则 ref 回调 → rAF → setState → 重渲染 → ref 回调 会转成死循环。
   */
  const tabTagsRef = useRef<number[]>([]);
  /**
   * ★★ 重新取三个 Tab 的 native tag（显式焦点全靠它）。
   *
   *   ★ 2026-10-29 修「遥控器管不住 Tab」。原来取 tag 的是挂在
   *     `[tabRects, tab]` 上的一个 effect，而且**一个取不到就整批 `return`**：
   *       · 进「设置」再返回时 Tab 栏是**卸载重建**的 —— 三个 Pressable 变成
   *         新的原生视图、新的 tag；但 `tab` / `tabRects` 一个都没变，
   *         effect 不重跑，`tabTags` 于是**一直指着已经销毁的 tag**；
   *       · Android 拿到失效 id 时 `findViewById` 找不到就退回**空间搜索**，
   *         而 Fabric 的 tag 是会被回收复用的 —— 运气不好直接命中别的控件。
   *     表现就是"左右键管不住 Tab / 一按焦点就跑到别处去"。
   *
   *   ★ 现在改成**跟着 ref 回调走**：哪个 Tab 的原生视图换了就重算一次，
   *     挂载、重挂载、首帧都覆盖到。`requestAnimationFrame` 是因为 ref 回调
   *     发生在 commit 里，等这一帧画完再取，原生视图才真的挂到父节点上。
   *
   *   ★ 这里**不加"已排队"的闸门**：那个标志一旦因为 App 切到后台、
   *     rAF 被丢掉而没复位，tag 就再也算不出来了 —— 一次多排两帧无所谓。
   */
  const resolveTabTags = useCallback(() => {
    requestAnimationFrame(() => {
      const tags: number[] = [];
      for (let i = 0; i < TABS.length; i += 1) {
        const node = tabRefs.current[i];
        const tag = node ? findNodeHandle(node) : null;
        // 还没挂上 —— 这次先不算，等下一次 ref 回调再来（不放弃整批）
        if (tag == null) return;
        tags.push(tag);
      }
      const prev = tabTagsRef.current;
      if (prev.length === tags.length && prev.every((t, i) => t === tags[i])) {
        return;
      }
      tabTagsRef.current = tags;
      setTabTags(tags);
    });
  }, []);
  /**
   * Tab 的 ref：**身份要稳定**。
   *
   * ★ 内联的 `ref={node => ...}` 每次渲染都是新函数，React 会把旧的
   *   先解绑（`null`）再绑新的 —— 等于每次重渲染都触发一遍重算。
   *   用 `useMemo` 固定下来之后，只有真的挂载 / 卸载才会回调。
   */
  const tabRefSetters = useMemo(
    () =>
      TABS.map(
        (_item, index) =>
          (node: React.ElementRef<typeof Pressable> | null) => {
            if (tabRefs.current[index] === node) return;
            tabRefs.current[index] = node;
            resolveTabTags();
          },
      ),
    [resolveTabTags],
  );
  /**
   * ★ TV 首选焦点只请求一次。
   *
   *   `hasTVPreferredFocus` 在 Android 上会被 RN 翻译成 requestFocus()。
   *   只要这个 prop 一直是 true，每次重渲染都会把焦点**抢回**当前 Tab ——
   *   用户按方向键刚移到「分类」，一次重渲染就又跳回去（2026-10-22 反馈
   *   「向 Tab 调整就快速跳到其他」）。所以第一次拿到焦点后立刻撤掉。
   *
   *   ★★ 初值必须为 false（不能在 createView 阶段就传 true）：
   *     Fabric 在 `createViewInstance` 时视图尚未挂到父节点（`parent == null`），
   *     那时 `requestFocus()` 只会在孤立节点上置 `PFLAG_FOCUSED` 并提前派发一次
   *     假 `onFocus`，把 `tabFocusPendingRef` 提前清成 false，导致挂载后的重试全部短路。
   */
  const [tabFocusPending, setTabFocusPending] = useState(false);
  /** 当前是否有任意一个底部 Tab 持有焦点（供遥控器返回键判断） */
  const tabFocusedRef = useRef(false);
  /**
   * ★★ 进 Tab 层 / 从设置页返回时，把「首选焦点」**延后**再挂上（可重试）。
   */
  const tabFocusPendingRef = useRef(true);
  /** 同步写 ref + state：定时器里要读「最新」的 pending，读闭包里的旧值会误判 */
  const setTabFocusPendingNow = useCallback((value: boolean) => {
    tabFocusPendingRef.current = value;
    setTabFocusPending(value);
  }, []);
  useEffect(() => {
    if (route.name !== 'tabs') return;
    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    // ★ 每次进 Tab 层（含从设置页返回）必须先把 pending 复位成 true，
    //   否则启动后一旦触发过 onFocus，从设置页返回时 pending 仍是 false，
    //   下面的重试会全部直接 return。
    tabFocusPendingRef.current = true;
    setTabFocusPending(false);

    const requestFocusOnce = (delay: number) => {
      timers.push(
        setTimeout(() => {
          if (cancelled || !tabFocusPendingRef.current) return;
          setTabFocusPending(false);
          timers.push(
            setTimeout(() => {
              if (cancelled || !tabFocusPendingRef.current) return;
              setTabFocusPending(true);
            }, 32),
          );
        }, delay),
      );
    };

    requestFocusOnce(16);
    requestFocusOnce(120);
    requestFocusOnce(400);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [route.name]);
  const [session, setSession] = useState<PlaySession | null>(null);
  /** 播放器是不是收成了角落里的悬浮小窗 */
  const [mini, setMini] = useState(false);

  /**
   * 三个 Tab。
   *
   * ★ 只有**访问过**的页面才挂载 —— 一上来就把首页 + 分类 + 搜索全挂上，
   *   三个页面会同时发请求，本来首页就慢，等于雪上加霜。
   *
   * ★★ 这里**不用 ScrollView 分页器**，只渲染当前这一页。
   *   之前用横向 `ScrollView + pagingEnabled` 做左右滑动切页，有两个问题：
   *     1. 首页的板块本身就是横向滚动的，Android 上两个横向滚动容器嵌套时
   *        **外层先拦截**（父级的 onInterceptTouchEvent 先跑），手指在板块上
   *        横滑会被分页器抢走，板块反而滚不动；
   *     2. 切页要调 `scrollTo`，多一层依赖 —— 它没生效的话点 Tab 就切不动。
   *   改成"状态直接决定渲染哪一页"之后，点 Tab 是**确定**生效的。
   *   代价是没有横滑切页 —— 但首页那种结构本来也滑不动，B 站的顶部 Tab
   *   同样只支持点击。
   */
  const [visited, setVisited] = useState<Record<Tab, boolean>>({
    home: true,
    category: false,
    search: false,
  });

  /** 有没有可升级的新版本 —— 有就在「设置」按钮上点个提示点（见下面的静默检查） */
  const update = useUpdateState();
  const hasNewVersion = update.phase === 'available';

  const tabIndexOf = useCallback(
    (id: Tab): number => TABS.findIndex(t => t.id === id),
    [],
  );

  const goToTab = useCallback((id: Tab) => {
    setTab(id);
    setVisited(prev => (prev[id] ? prev : { ...prev, [id]: true }));
  }, []);

  /**
   * ★ 按住 Tab 时胶囊的"回弹"。
   *
   *   ★★ 两个值、两层扩张（2026-10-16 用户给的判据）：
   *     **「整条扩张，然后胶囊扩张的要超过整条」**
   *
   *     · `tabPress` → 桌面那条 **tab 条**整体放大一点（1 → 1.04）
   *     · `capsulePress` → **选中气泡**放大得更多（纵向 1 → 1.30），
   *       且**慢半拍**（`delay`）—— 观感是"条先鼓起、气泡再顶出来"，
   *       顶出来的那一截正好越过 tab 条的上下边（静止态是内缩的，见 `BUBBLE_INSET`）
   *
   *   ★ 弹簧**故意用不同参数**：条那条快而硬（跟手），胶囊那条慢而弹
   *     （"液体"那点黏滞感）。两个都关掉 native driver 会踩坑，
   *     所以：条用 native（纯 transform），胶囊留着 JS driver ——
   *     同一个视图上不能混，这里正好是两个视图。
   *
   *   ★ 2026-10-23 起**不再用** iOS 26 的 `UIGlassEffect.isInteractive`：
   *     它会把 RN 的触摸流 cancel 掉，拖动切 Tab 直接失效（见下面
   *     `interactiveTabGlass` 撤掉的说明）。所以这两层 JS 弹簧就是**唯一**的
   *     按压反馈，别再当成"叠在系统动画上的补充"。
   */
  const tabPress = useRef(new Animated.Value(0)).current;
  /** 胶囊那一层（慢半拍、幅度更大） */
  const capsulePress = useRef(new Animated.Value(0)).current;
  const [pressedTab, setPressedTab] = useState<Tab | null>(null);

  const setTabHeld = useCallback(
    (held: boolean, id?: Tab) => {
      setPressedTab(held ? id ?? null : null);
      Animated.spring(tabPress, {
        toValue: held ? 1 : 0,
        useNativeDriver: true,
        speed: 40,
        bounciness: 14,
      }).start();
      Animated.spring(capsulePress, {
        toValue: held ? 1 : 0,
        // ★ 这条挂着 `capsuleL`（拖拽要 `setValue`，只能 JS driver），
        //   所以它也只能 JS driver —— 同一个视图上两者不能混
        useNativeDriver: false,
        speed: 26,
        bounciness: 18,
        delay: held ? 70 : 0,
      }).start();
    },
    [tabPress, capsulePress],
  );

  /** 整条：鼓一点就够（再大就成"整体缩放"了，不像玻璃） */
  const tabScale = tabPress.interpolate({
    inputRange: [0, 1],
    // ★ 没有原生交互玻璃之后，"按压扩张"全靠这一层 + 下面的气泡：
    //   条先鼓一点、气泡再越过条（见 `capsuleScaleY`）。
    outputRange: [1, 1.04],
  });

  /**
   * 气泡：按压时**明显越过** tab 条上下边。
   *
   * ★ 静止态是内缩 4pt 的，所以纵向要给到 1.30 才真的涨出去
   *   （参考图里按下那一刻气泡是压在整条边上的）。
   */
  const capsuleScaleY = capsulePress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.3],
  });
  /** 横向也扩一点，"扩张"不该只有纵向 */
  const capsuleScaleX = capsulePress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.05],
  });

  /**
   * ★★ 内容区横滑切 Tab。
   *
   * 这里**自己用 PanResponder 实现分页**，不用原生 ScrollView ——
   * 因为 Android 上原生 ScrollView 的拦截发生在 **native 层**
   * （父级的 onInterceptTouchEvent 先于子级），JS 根本没机会判断
   * "手指是按在哪儿"。换成 JS 驱动之后就能先问一句：
   * 手指要是按在横向滚动的板块上，就**不接管**，让板块自己滚。
   *
   * 用 `useNativeDriver: false`：拖拽过程要 setValue 跟手，
   * 一个 Animated.Value 不能既被 setValue 写、又被原生动画驱动。
   */
  const pageX = useRef(new Animated.Value(0)).current;
  const settledX = useRef(0);

  const settleTo = useCallback(
    (index: number) => {
      settledX.current = -index * width;
      Animated.spring(pageX, {
        toValue: settledX.current,
        useNativeDriver: false,
        friction: 10,
        tension: 70,
      }).start();
    },
    [pageX, width],
  );

  // 点 Tab 切过去时，页面跟着滑
  useEffect(() => {
    settleTo(tabIndexOf(tab));
  }, [tab, tabIndexOf, settleTo]);

  /** 底部 Tab 栏里那个滑动胶囊 */
  const [tabRects, setTabRects] = useState<Array<{ x: number; width: number }>>(
    [],
  );
  const capsuleL = useRef(new Animated.Value(0)).current;
  /**
   * 气泡**宽度**（JS driver，跟 `capsuleL` 一样）。
   * 平时是一格的宽度；按在两格中间时要弹成两格宽，所以不能写成静态样式。
   */
  const capsuleW = useRef(new Animated.Value(0)).current;
  /** 第一次布局时直接给值，不要从 0 弹出来 */
  const capsuleInited = useRef(false);
  /** 原生拖动进行中 —— 玻璃会 cancel 触摸，别把按压态也一起清了 */
  const dragging = useRef(false);
  /** 按下时气泡要跨哪两格（null = 只盖一格） */
  const [pressSpan, setPressSpan] = useState<{
    from: number;
    to: number;
  } | null>(null);
  /** 气泡左边缘当前该在哪 —— 拖拽要从这个值算起（按下时对齐到被按的那一格） */
  const capsuleTarget = useRef(0);

  const handleTabLayout = useCallback((index: number, e: LayoutChangeEvent) => {
    const { x, width: w } = e.nativeEvent.layout;
    setTabRects(prev => {
      if (prev[index] && prev[index].x === x && prev[index].width === w)
        return prev;
      const next = prev.slice();
      next[index] = { x, width: w };
      return next;
    });
  }, []);

  // 按下时气泡先跟到被按的那一格（跨格时是那两格）；松开后由 tab 状态确认切换。
  useEffect(() => {
    if (pressedTab == null) return;
    const from = pressSpan ? pressSpan.from : tabIndexOf(pressedTab);
    const to = pressSpan ? pressSpan.to : from;
    const a = tabRects[from];
    const b = tabRects[to];
    if (!a || !b) return;
    Animated.spring(capsuleL, {
      toValue: a.x,
      useNativeDriver: false,
      friction: 10,
      tension: 95,
    }).start();
    Animated.spring(capsuleW, {
      toValue: b.x + b.width - a.x + BUBBLE_X * 2,
      useNativeDriver: false,
      friction: 10,
      tension: 95,
    }).start();
  }, [pressedTab, pressSpan, tabRects, tabIndexOf, capsuleL, capsuleW]);

  /**
   * 按下某一格时决定气泡要不要跨格。
   *
   * ★ 落点离左右边界 `SPAN_ZONE` 以内 → 跨到那一侧。
   *   遥控器没有"按在哪儿"这回事（`locationX` 不可靠），直接不跨。
   */
  const handleTabPressIn = useCallback(
    (index: number, e: GestureResponderEvent) => {
      const rect = tabRects[index];
      let span: { from: number; to: number } | null = null;
      if (rect && !isRemoteMode()) {
        const x = e.nativeEvent.locationX;
        if (Number.isFinite(x)) {
          if (index > 0 && x < SPAN_ZONE) {
            span = { from: index - 1, to: index };
          } else if (index < TABS.length - 1 && rect.width - x < SPAN_ZONE) {
            span = { from: index, to: index + 1 };
          }
        }
      }
      // ★ 拖拽是从"气泡当前停在哪"算起的 —— 在按下的**这一刻**定下来，
      //   之后跨格状态怎么变都不再动它（否则拖到一半起点会被改掉）。
      const anchor = span ? tabRects[span.from] : rect;
      if (anchor) capsuleTarget.current = anchor.x;
      setPressSpan(span);
      setTabHeld(true, TABS[index].id);
    },
    [tabRects, setTabHeld],
  );

  /**
   * ★★ 从「设置」回到 Tab 层时补一次 tag 重算（2026-10-29）。
   *
   *   Tab 栏卸载重建时 ref 回调本来就会来一遍，这里是**兜底**：
   *   万一那一遍 ref 回调撞上原生视图还没 attach（`findNodeHandle` 拿到
   *   null），tag 就永远停在旧值上 —— 而遥控器恰恰就是在这条路径上失灵的。
   */
  useEffect(() => {
    if (route.name === 'tabs') resolveTabTags();
  }, [route.name, resolveTabTags]);

  /**
   * 把胶囊挪到某个下标的位置。
   *
   * ★★ 切换时那下"**流体般的变形**"就在这里：不是硬邦邦平移过去，
   *   而是**先抻长、再收回**：
   *     ① 宽度涨到「目标格宽 + 两格之间的距离」→ 胶囊一头先伸过去
   *     ② 位置滑到目标格（左边缘领先、宽度慢半拍）→ 中间被拉成一条"桥"
   *     ③ 宽度收回目标格宽 → 交代清楚，落成一颗规整的胶囊
   *   ①② 同时起跑、刚度不同（那条桥就出来了），③ 在 ① 结束时接上。
   *
   * ★ 做饭的是 `capsuleL`（位置）+ `capsuleW`（宽度）。拖拽过程中
   *   `syncTo` 直接 `setValue` 写 `capsuleL`（`setValue` 会掐掉正在跑的动画），
   *   所以跟手不会被这条路径干扰。
   */
  const settleCapsule = useCallback(
    (index: number, animated = true) => {
      const rect = tabRects[index];
      if (!rect) return;
      capsuleTarget.current = rect.x;
      const w = rect.width + BUBBLE_X * 2;
      if (!animated || !capsuleInited.current) {
        capsuleInited.current = true;
        capsuleL.setValue(rect.x);
        capsuleW.setValue(w);
        return;
      }
      // ★ 纯平移（不要拉长）—— 用户报"先抻长、滑过去再收的是错的"
      Animated.spring(capsuleL, {
        toValue: rect.x,
        useNativeDriver: false,
        friction: 9,
        tension: 80,
      }).start();
      // 跨格按下的那一下要收回来，宽度也得跟着弹
      Animated.spring(capsuleW, {
        toValue: w,
        useNativeDriver: false,
        friction: 9,
        tension: 80,
      }).start();
    },
    [tabRects, capsuleL, capsuleW],
  );

  /** 把页面和胶囊一起摆到 `indexFloat` 这个连续位置上（拖拽跟手） */
  const syncTo = useCallback(
    (indexFloat: number) => {
      const first = tabRects[0]?.x ?? 0;
      const stride = (tabRects[1]?.x ?? first) - first || 1;
      const clamped = Math.min(TABS.length - 1, Math.max(0, indexFloat));
      pageX.setValue(-clamped * width);
      // 拖拽时胶囊保持刚体（宽度不动）："流淌"只留给落位
      capsuleL.setValue(first + clamped * stride);
      // ★ 如果是从"跨格按下"接上的拖拽，宽度要收回单格
      const base = tabRects[Math.round(clamped)] ?? tabRects[0];
      if (base) capsuleW.setValue(base.width + BUBBLE_X * 2);
    },
    [tabRects, pageX, capsuleL, capsuleW, width],
  );

  /**
   * ★★ 气泡落位**只认状态**：没在按住时，永远对齐当前 Tab。
   *
   *   之前是"点 Tab 切过去时滑一下 + 松开时再收一下"，两处回调谁后跑谁说了算 ——
   *   回调顺序一变（或按下被 cancel 没走 onPressOut），气泡就会停在别的格上
   *   （用户 2026-10-23 报：首页是选中的，气泡却停在搜索）。
   *   现在只有一个出口：`pressedTab == null` 就落位到 `tab`，不会有两股力抢。
   */
  useEffect(() => {
    if (pressedTab != null) return;
    settleCapsule(tabIndexOf(tab));
  }, [pressedTab, tab, tabIndexOf, settleCapsule]);

  /**
   * ★★ 把**页面和胶囊一起**摆到 `indexFloat` 这个连续位置上（0 ~ N-1 之间的小数）。
   *
   * 拖胶囊和滑页面是两个方向，但表现必须是同一件事：
   * 手指走到哪儿，胶囊和内容就一起跟到哪儿 —— 而不是等松手了页面才跳过去。
   * 两边都调这一个函数，就不会各走各的。
   */

  /**
   * ★ 按住胶囊左右拖 = 切 Tab。
   *
   * 手势只落在 **Tab 栏**上，内容区完全不管 ——
   * 这样首页那些横向板块就能正常滚自己的，两边不再抢手势。
   *
   * `onStartShouldSetPanResponder` 返回 false、只在横向位移超过阈值时才接管：
   * 轻点仍然走 Tab 自己的 Pressable（点哪个切哪个），拖动才由这里接管。
   */
  /**
   * 拖动中：把位移换算成"胶囊走到哪一格"，**页面同步跟手**。
   * ★ PanResponder（Android / iOS 25 及以下）和原生 pan（iOS 26）共用这一份。
   */
  const moveDrag = useCallback(
    (dx: number) => {
      const first = tabRects[0]?.x ?? 0;
      const last = tabRects[tabRects.length - 1]?.x ?? 0;
      const stride = (tabRects[1]?.x ?? first) - first || 1;
      const next = Math.min(last, Math.max(first, capsuleTarget.current + dx));
      syncTo((next - first) / stride);
    },
    [tabRects, syncTo],
  );

  /** 松手：按胶囊**当前停在哪**找最近的 Tab，换过去 / 弹回 */
  const endDrag = useCallback(
    (dx: number) => {
      if (!tabRects.length) return;
      const moved = capsuleTarget.current + dx;
      let nearest = 0;
      for (let i = 0; i < tabRects.length; i += 1) {
        if (
          Math.abs(tabRects[i].x - moved) <
          Math.abs(tabRects[nearest].x - moved)
        ) {
          nearest = i;
        }
      }
      const target = TABS[nearest];
      if (target.id !== tab) {
        goToTab(target.id); // effect 里会把两边都弹到位
      } else {
        // 没换 Tab —— 胶囊和**页面**都要弹回原位
        // （拖动时页面是跟着走的，只弹胶囊会把页面留在半路）
        settleCapsule(nearest);
        settleTo(nearest);
      }
    },
    [tabRects, tab, goToTab, settleCapsule, settleTo],
  );

  /**
   * ★ iOS 26 的原生拖动事件（`GlassView.panEnabled`）。
   *
   *   触摸流被玻璃 cancel 掉之后，`onTouchEnd` 不会来，所以**换 Tab 必须在这里收尾**；
   *   点击（没拖动）仍然走 `onTouchEnd`。
   */
  const handleTabPan = useCallback(
    (index: number, e: NativeSyntheticEvent<NativePanEvent>) => {
      const { state, translationX } = e.nativeEvent;
      const id = TABS[index].id;
      if (state === 0) {
        dragging.current = true;
        // 拖动时气泡跟着手指走，不需要"跨格"那个展开态
        setPressSpan(null);
        // 玻璃把触摸 cancel 之后按压态会掉，这里补回来（气泡保持放大）
        setTabHeld(true, id);
        return;
      }
      if (state === 1) {
        moveDrag(translationX);
        return;
      }
      dragging.current = false;
      setTabHeld(false, id);
      if (state === 2) endDrag(translationX);
      else settleCapsule(tabIndexOf(tab));
    },
    [moveDrag, endDrag, setTabHeld, settleCapsule, tabIndexOf, tab],
  );

  const tabBarPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => moveDrag(g.dx),
        onPanResponderRelease: (_e, g) => endDrag(g.dx),
        onPanResponderTerminate: () => settleCapsule(tabIndexOf(tab)),
      }),
    [moveDrag, endDrag, settleCapsule, tabIndexOf, tab],
  );


  const pagerPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          // ★ 手指按在横向板块上就不接管 —— 那是给板块滚的
          !isOnHorizontalRow() &&
          Math.abs(g.dx) > 10 &&
          Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => {
          const min = -(TABS.length - 1) * width;
          const x = Math.min(0, Math.max(min, settledX.current + g.dx));
          // ★ 同一个同步器 —— 胶囊跟着页面走
          syncTo(-x / width);
        },
        onPanResponderRelease: (_e, g) => {
          const index = tabIndexOf(tab);
          let next = index;
          if (g.dx < -60) next = Math.min(index + 1, TABS.length - 1);
          else if (g.dx > 60) next = Math.max(index - 1, 0);

          if (next !== index) {
            goToTab(TABS[next].id); // effect 里会把两边都弹到位
          } else {
            // 没滑够就一起弹回去
            settleTo(index);
            settleCapsule(index);
          }
        },
        onPanResponderTerminate: () => {
          settleTo(tabIndexOf(tab));
          settleCapsule(tabIndexOf(tab));
        },
      }),
    [width, tab, goToTab, settleTo, settleCapsule, syncTo, tabIndexOf],
  );

  /**
   * ★ 详情和播放合成一屏：点卡片直接起播第 1 集。
   *   原先"详情页 → 选集 → 播放页"两屏是重复的，操作上也多一跳。
   */
  const openSeries = useCallback((item: VodItem) => {
    setSession({ item, episodeIndex: 0 });
    setMini(false);
  }, []);

  /** 全屏 → 收成小窗（不结束播放） */
  const collapsePlayer = useCallback(() => setMini(true), []);
  /** 小窗 → 展开回全屏 */
  const expandPlayer = useCallback(() => setMini(false), []);
  /** 小窗上按关闭 —— 结束这次播放 */
  const closePlayer = useCallback(() => setSession(null), []);

  const backToTabs = useCallback(() => setRoute({ name: 'tabs' }), []);

  /**
   * ★ 启动时**静默**查一次更新。
   *
   *   查到了只在「设置」按钮上点个提示点（不弹窗、不打断任何东西）；
   *   查不到（离线 / 清单还没生成）就什么都不做 —— 这功能不该在启动路径上
   *   制造任何失败感。真正的"下载并安装"在设置页里（见 `update/updater.ts`）。
   */
  useEffect(() => {
    void checkForUpdate();
  }, []);

  /**
   * 接管 Android 硬件返回键。
   *
   * ★ 不接的话系统会直接退出 App。
   *   播放页 → 详情页 → Tab 层；在 Tab 层但不在首页就先滑回首页；
   *   只有在首页才交给系统退出。
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        // 全屏播放中 → 先收成小窗（不打断播放）；已经在小窗 → 关掉这次播放
        if (session && !mini) {
          setMini(true);
          return true;
        }
        if (session && mini) {
          setSession(null);
          return true;
        }
        if (route.name === 'settings') {
          setRoute({ name: 'tabs' });
          return true;
        }
        // ★ TV 遥控器操作时：如果焦点在内容区（不在底部 Tab 栏上），
        //   按一次返回键先把焦点拉回底部当前 Tab（方便在无限加载的分类页或长列表中间随时切 Tab）。
        if (isRemoteMode() && !tabFocusedRef.current) {
          tabFocusPendingRef.current = true;
          setTabFocusPending(false);
          setTimeout(() => {
            if (tabFocusPendingRef.current) setTabFocusPending(true);
          }, 16);
          return true;
        }
        if (tab !== 'home') {
          goToTab('home');
          if (isRemoteMode()) {
            tabFocusPendingRef.current = true;
            setTabFocusPending(false);
            setTimeout(() => {
              if (tabFocusPendingRef.current) setTabFocusPending(true);
            }, 16);
          }
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [route, tab, goToTab, session, mini]);

  // 全屏播放时状态栏文字要用亮色（视频背景是黑的）；收成小窗后回到主题色
  const fullscreenPlaying = !!session && !mini;

  const overlay = session ? (
    // ★ 覆盖层整体 box-none：小窗模式下触摸要能透到下面的 Tab 栏。
    //   全屏时 PlayerScreen 自己的 root 是 auto，会把整屏吃掉。
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <PlayerScreen
        item={session.item}
        episodeIndex={session.episodeIndex}
        mini={mini}
        onBack={collapsePlayer}
        onExpand={expandPlayer}
        onClose={closePlayer}
      />
    </View>
  ) : null;

  /**
   * 选中气泡 —— 跟着手指走的那一颗"玻璃珠"。
   *
   * ★★ 两个状态（见 `BUBBLE_X` / `BUBBLE_INSET` 的注释）：
   *   · 静止：收在整条里面、淡灰；
   *   · 按下：`capsuleScaleX/Y` 放大 + `tabBubbleLit` 亮起来。
   *
   *   横向比 Tab 格各宽 `BUBBLE_X`，所以宽度按"格宽 + 两倍探出"算，
   *   再靠 `left: -BUBBLE_X` 把多出来的那一半让回左边。
   *   位置（`capsuleL`）仍然对齐 `tabRects[i].x` —— 拖拽、落位的数学一行都不用改。
   */
  const capsule =
    tabRects.length === TABS.length ? (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.tabBubble,
          {
            width: capsuleW,
            transform: [
              { translateX: capsuleL },
              { scaleX: capsuleScaleX },
              { scaleY: capsuleScaleY },
            ],
          },
        ]}
      >
        <View style={styles.tabBubbleInner} />
        {/* 按下才亮：opacity 跟着 `capsulePress` 走，跟放大同一条弹簧 */}
        <Animated.View
          style={[styles.tabBubbleLit, { opacity: capsulePress }]}
        />
        {/*
          真玻璃材质。垫在着色层上面 —— 材质采样到的就是那层灰/白，
          观感等于给玻璃上了个 tint；而且它是非交互的，不吃拖动。
        */}
        {nativeBubble ? (
          <GlassBox style={styles.tabBubbleGlass} cornerRadius={radius.pill} />
        ) : null}
      </Animated.View>
    ) : null;

  /**
   * 三个 Tab 按钮。两端渲染的是同一份 —— 免得改了一边忘了另一边。
   *
   * ★★ **量位置必须量外面这个槽位**（`tabSlot`），不能量按钮本身：
   *   iOS 26 那一支每个 Tab 外面还包了一层 `GlassBox`，按钮的 `onLayout`
   *   拿到的是「相对于那层包装」的 x —— 三格全是 0。
   *   结果就是气泡永远回第一格、拖动步长算成 1px、怎么拖都换不了页
   *   （用户 2026-10-23 报的两个症状其实是同一个根因）。
   */
  const tabButtons = TABS.map((item, index) => {
    const button = (
      <TabButton
        key={item.id}
        ref={tabRefSetters[index]}
        name={item.id}
        label={item.label}
        active={tab === item.id}
        pressed={
          pressedTab === item.id ||
          (pressSpan != null && index >= pressSpan.from && index <= pressSpan.to)
        }
        // ★ 交互玻璃那一支是纯展示，触摸交给玻璃（见 `passive` 的注释）
        passive={interactiveTabGlass}
        // ★ 给原生层（MainActivity）标记当前选中的 Tab：
        //   全屏播放时撤掉 tab-active，防止焦点穿透到播放器底下的 Tab 栏。
        testID={
          tab === item.id && !fullscreenPlaying ? 'tab-active' : `tab-${item.id}`
        }
        // ★ TV 上初始/返回时焦点落在当前 Tab 上，而不是被右上角「设置」抢走。
        preferredFocus={tabFocusPending && tab === item.id}
        onFocus={() => {
          tabFocusedRef.current = true;
          setTabFocusPendingNow(false);
        }}
        onBlur={() => {
          tabFocusedRef.current = false;
        }}
        // ★ 显式左右焦点：只在这三个 Tab 之间走，不会被「设置」抢
        // ★ 边界回指自己：最左边继续按左、最右边继续按右时不交给 Android
        // 空间搜索，否则它可能跳到设置按钮或页面里的其他可聚焦控件。
        nextFocusLeft={tabTags[index - 1] ?? tabTags[index]}
        nextFocusRight={tabTags[index + 1] ?? tabTags[index]}
        /*
          ★★ 上下：**往下留在本格，往上交还给空间搜索**（2026-10-29 修）。

            上一版把两个都指回自己（commit「keep vertical focus within
            tab bar」），本意是不让空间搜索把焦点从 Tab 栏里带走。但电视上
            没有"点一下别处"这回事 —— 焦点一旦进到 Tab 栏，**按上永远回不去
            内容区**，遥控器就只剩三个 Tab 可点，用户报的就是"Tab 无法遥控"。

            · DOWN 仍然指回自己：Tab 栏下面本来就没有控件，交给空间搜索
              只会乱挑（跳到右上角「设置」或者别的页里）；
            · UP 放开：按上就回到内容区最近的一张卡片，这才是电视的操作习惯。
        */
        nextFocusDown={tabTags[index]}
        onPress={() => goToTab(item.id)}
        onPressIn={e => handleTabPressIn(index, e)}
        // ★ 只清状态：气泡落位交给上面那个 effect，别在这里再抢一次
        onPressOut={() => {
          setPressSpan(null);
          setTabHeld(false, item.id);
        }}
      />
    );

    return (
      <View
        key={item.id}
        onLayout={e => handleTabLayout(index, e)}
      >
        {interactiveTabGlass ? (
          <GlassBox
            style={styles.tabItemGlass}
            cornerRadius={radius.pill}
            interactive
            // ★ 玻璃会 cancel RN 的触摸流 —— 拖动改由原生 pan 送回来
            panEnabled
            onPan={e => handleTabPan(index, e)}
            onTouchStart={e => handleTabPressIn(index, e)}
            onTouchEnd={() => {
              setPressSpan(null);
              setTabHeld(false, item.id);
              goToTab(item.id);
            }}
            onTouchCancel={() => {
              setPressSpan(null);
              // 拖动中别清：按压态由 `handleTabPan` 收尾
              if (!dragging.current) setTabHeld(false, item.id);
            }}
          >
            {button}
          </GlassBox>
        ) : (
          button
        )}
      </View>
    );
  });

  if (route.name === 'settings') {
    return (
      <>
        <StatusBar barStyle={color.statusBar} />
        <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
          <SettingsScreen onBack={backToTabs} />
        </SafeAreaView>
        {overlay}
      </>
    );
  }

  return (
    <>
      <StatusBar
        barStyle={fullscreenPlaying ? 'light-content' : color.statusBar}
      />
      {/*
        ★★ 底部**只留 top 边** —— 这就是「Tab 栏下面那条白条」的根因。
          之前 `edges={['top','bottom']}` 把整个内容区的下边界压在安全区上沿
          （约 34pt）：那一块永远画不到内容，只剩 `color.bg` 一层实色。
          亮色主题下 `bg` 是 #F6F6F9 —— 于是玻璃条底下横着一条近白的实心带
          （用户 2026-10-16 报的「白条遮挡」）。
          去掉之后内容一直铺到屏幕底边，那条带自然消失。
        ★ 代价是内容会压到 Home Indicator 上 —— 这正是 iOS 26 的做法
          （悬浮栏本来就该浮在内容之上）。所以 Tab 栏自己按安全区抬高
          （见 `tabBarWrap`），列表底部留白也要加上这一段（见 `useTabBarSpace`）。
      */}
      <SafeAreaView
        style={styles.root}
        edges={['top']}
        importantForAccessibility={
          fullscreenPlaying ? 'no-hide-descendants' : 'auto'
        }
        pointerEvents={fullscreenPlaying ? 'none' : 'auto'}
      >
        <View style={styles.header}>
          <View style={styles.headerMain}>
            <Text style={styles.brand}>小包子影视</Text>
          </View>
          <Pressable
            onPress={() => setRoute({ name: 'settings' })}
            hitSlop={8}
            nextFocusDown={tabTags[TABS.findIndex(item => item.id === tab)]}
          >
            <GlassBox style={styles.settingsBtn} cornerRadius={radius.pill}>
              {/* ★ 有新版才出现的小点：不弹窗、不打扰，但一眼看得见 */}
              <View style={styles.settingsRow}>
                {hasNewVersion ? <View style={styles.updateDot} /> : null}
                <Text style={styles.settingsText}>设置</Text>
              </View>
            </GlassBox>
          </Pressable>
        </View>

        {/*
          三页并排放在一条横排里，整条按 pageX 平移。
          都保持挂载 —— 切回来不丢滚动位置。
          ★ 非当前页用 no-hide-descendants 配合原生 FOCUS_BLOCK_DESCENDANTS
            屏蔽空间焦点搜索，避免遥控器方向键把焦点跳进屏幕外的隐藏页面。
        */}
        <View style={styles.body} {...pagerPan.panHandlers}>
          <Animated.View
            style={[
              styles.pageRow,
              {
                width: width * TABS.length,
                transform: [{ translateX: pageX }],
              },
            ]}
          >
            <View
              style={{ width }}
              importantForAccessibility={
                tab === 'home' ? 'auto' : 'no-hide-descendants'
              }
              pointerEvents={tab === 'home' ? 'auto' : 'none'}
            >
              {visited.home ? <HomeScreen onOpen={openSeries} /> : null}
            </View>
            <View
              style={{ width }}
              importantForAccessibility={
                tab === 'category' ? 'auto' : 'no-hide-descendants'
              }
              pointerEvents={tab === 'category' ? 'auto' : 'none'}
            >
              {visited.category ? <CategoryScreen onOpen={openSeries} /> : null}
            </View>
            <View
              style={{ width }}
              importantForAccessibility={
                tab === 'search' ? 'auto' : 'no-hide-descendants'
              }
              pointerEvents={tab === 'search' ? 'auto' : 'none'}
            >
              {visited.search ? <SearchScreen onOpen={openSeries} /> : null}
            </View>
          </Animated.View>
        </View>

        {/* 悬浮玻璃 Tab 栏：居中、不铺满、离底边留一点 */}
        <View style={styles.tabBarWrap} pointerEvents="box-none">
          {/* 拖拽手势挂在这一层：内容区不受影响，板块该滚滚 */}
          <View {...tabBarPan.panHandlers}>
            <Animated.View style={{ transform: [{ scale: tabScale }] }}>
              <GlassBox
                style={styles.tabBar}
                cornerRadius={radius.pill}
                // 视觉材质统一复用设置页的 GlassView；按压回弹由 Tab 自身动画控制。
                interactive={false}
              >
                {/*
                  GlassView 是绝对定位的材质层；当系统没有把材质成功合成出来时，
                  不能让整个外壳退成透明。这个半透明底是参考图里的完整外层胶囊，
                  也给 Android 提供稳定的视觉兜底。
                */}
                {/*
                  ★★ 有**真·液态玻璃**时**不要**垫这层白底（2026-10-23 修）：
                     `tabBarSurface` 是玻璃的**兄弟节点、画在玻璃上面**的，
                     0.52 的白会直接把模糊/折射盖掉 —— 用户报"模糊背景也没有"。
                     它只在没有真材质时（玻璃关掉 / iOS 25 及以下 / Android）兜底。
                */}
                {nativeGlass && LIQUID_GLASS_AVAILABLE ? null : (
                  <View pointerEvents="none" style={styles.tabBarSurface} />
                )}
                {capsule}
                {tabButtons}
              </GlassBox>
            </Animated.View>
          </View>
        </View>
      </SafeAreaView>
      {overlay}
    </>
  );
}

/** 底部 Tab：选中项文字高亮 + 下面一个小点 */
const TabButton = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  {
    /** 图标用哪个 —— 跟 Tab id 一一对应 */
    name: Tab;
    label: string;
    active: boolean;
    pressed?: boolean;
    /** 原生层用于定位当前 Tab 的标识 */
    testID?: string;
    /** TV：挂载时是否请求焦点（当前 Tab 为 true） */
    preferredFocus?: boolean;
    /** TV：拿到焦点后通知外层撤掉「首选焦点」 */
    onFocus?: () => void;
    /** TV：失去焦点时通知外层更新焦点状态 */
    onBlur?: () => void;
    /** TV：左右方向键的显式目标（native tag） */
    nextFocusLeft?: number;
    nextFocusRight?: number;
    /**
     * TV：下方向键的显式目标（native tag）。
     *
     * ★ 只有 DOWN —— 上方向键**故意不挂**：电视上按上要能回到内容区，
     *   挂成自己就等于把焦点锁死在 Tab 栏里（见 `tabButtons` 里的说明）。
     */
    nextFocusDown?: number;
    /**
     * ★ **纯展示**：只负责画，完全不接收触摸（iOS 26 的交互玻璃那一支用）。
     *
     *   触摸要落到**玻璃自己身上**，系统的按压扩张才会动；所以这一层用
     *   `pointerEvents="none"` 让开（它会把原生 `userInteractionEnabled` 置 false）。
     *   拖动则由玻璃上的原生 pan 转给 JS（见 `handleTabPan`）。
     */
    passive?: boolean;
    onPress: () => void;
    /** 按住 —— 外层要拿落点判断气泡要不要跨格（见 `handleTabPressIn`） */
    onPressIn?: (e: GestureResponderEvent) => void;
    /** 松开 —— 给外面那层气泡做回弹 */
    onPressOut?: () => void;
  }
>(function TabButton(
  {
    name,
    label,
    active,
    pressed = false,
    passive,
    testID,
    preferredFocus,
    onFocus,
    onBlur,
    nextFocusLeft,
    nextFocusRight,
    nextFocusDown,
    onPress,
    onPressIn,
    onPressOut,
  },
  ref,
): React.JSX.Element {
  const { color } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);

  /**
   * 选中 / 按住 → 系统蓝；其余 → 暗一档的文字色。
   * ★ 图标和文字**同一个颜色**，参考图里选中项就是整组一起变蓝的。
   */
  const lit = active || pressed;
  const tint = lit ? color.tabActive : color.textDim;

  const content = (
    <>
      <TabIcon name={name} color={tint} />
      <Text
        numberOfLines={1}
        style={[styles.tabText, { color: tint }, lit && styles.tabTextLit]}
      >
        {label}
      </Text>
    </>
  );

  if (passive) {
    return (
      <View style={styles.tab} pointerEvents="none">
        {content}
      </View>
    );
  }

  return (
    <Pressable
      ref={ref}
      testID={testID}
      style={styles.tab}
      hasTVPreferredFocus={preferredFocus}
      onFocus={onFocus}
      onBlur={onBlur}
      nextFocusLeft={nextFocusLeft}
      nextFocusRight={nextFocusRight}
      nextFocusDown={nextFocusDown}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
    >
      {content}
    </Pressable>
  );
});

const makeStyles = (
  color: Palette,
  glassOn = true,
  liquidGlass = false,
  /** 底部安全区高度 —— 只有 `tabBarWrap` 用得上（见那边的注释） */
  safeBottom = 0,
) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: color.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingTop: space.sm,
      paddingBottom: space.sm,
    },
    headerMain: { flex: 1 },
    brand: { color: color.text, fontSize: 20, fontWeight: '700' },
    settingsBtn: {
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    settingsText: { color: color.text, fontSize: 13 },
    settingsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    updateDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: color.accent,
    },
    body: { flex: 1, overflow: 'hidden' },
    // 三页横排，整条按 pageX 平移
    pageRow: { flexDirection: 'row', height: '100%' },
    // 悬浮栏：整条居中，不铺满
    tabBarWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      // ★ 按底部安全区抬高。以前这段高度是根 `SafeAreaView` 的 bottom padding
      //   顶出来的；现在那个 padding 去掉了（就是它造成了底下那条白条），
      //   所以这里显式加回来 —— Tab 栏的**视觉位置跟从前完全一致**。
      bottom: TAB_BAR_BOTTOM + safeBottom,
      alignItems: 'center',
    },
    // ★ 这里**不设 padding** —— 胶囊是绝对定位的兄弟节点，父级一旦有 padding，
    //   "left: 0 到底算不算 padding" 在 Yoga 里很容易踩坑（绝对定位按 padding box，
    //   普通子节点按 content box，两者差一个 padding）。
    //   留白全部交给每个 Tab 自己的 paddingHorizontal。
    tabBar: {
      flexDirection: 'row',
      borderRadius: radius.pill,
      // ★★ 不能是 `hidden`：选中胶囊按住时要**探出 tab 条之外**
      //   （"胶囊扩张的要超过整条"），而 Android 的 ViewGroup 默认
      //   `clipChildren = true`，`overflow: 'hidden'` 会把越界那一截无声裁掉。
      //   RN 的 `overflow: 'visible'` 在 Android 上就是 `clipChildren = false`。
      //   ★ 玻璃自己不受影响：两端的玻璃都在**原生那侧自己裁圆角**
      //     （iOS `effectView.clipsToBounds` + cornerRadius，
      //      Android `GlassView.onDraw` 里 `clipPath.addRoundRect`）。
      overflow: 'visible',
      // ★ 垫在玻璃层**后面**的透光底（见 theme 里 bar 的注释）。
      //   之前这里是一层 0.88 的实底，玻璃背后没东西可透 ——
      //   iOS 没东西可糊、Android 没光可透，两端都退化成纯色板，
      //   表现就是"Tab 栏没有液态玻璃效果"。
      //   玻璃关掉 / 原生玻璃不可用时退回 barSolid。
      //
      // ★★ 但 **iOS 26 的真·液态玻璃例外：底色必须是全透明**。
      //   真玻璃是自己会折光的材质，采样的是它背后的所有东西 ——
      //   垫一层 rgba(16,16,22,0.5) 会被一并采进去，折射和高光全糊掉，
      //   看起来就又变回一块深色板。半透明底只是给"模糊兜底"用的。
      backgroundColor: liquidGlass
        ? 'transparent'
        : glassOn
        ? color.bar
        : color.barSolid,
    },
    tabBarSurface: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: radius.pill,
      backgroundColor: color.glass,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.glassBorder,
    },
    /**
     * 选中气泡的外框。
     *
     * ★ `left: -BUBBLE_X` + 内联宽度（格宽 + 2×BUBBLE_X）= 气泡左右各探出一截；
     *   `top/bottom: -BUBBLE_Y` = **越过整条 Tab 栏的上下边**。
     *   能画到外面去靠的是 `tabBar` 上的 `overflow: 'visible'`。
     */
    tabBubble: {
      position: 'absolute',
      left: -BUBBLE_X,
      // ★ 静止态是**内缩**的（不是探出去）—— 用户给的静止状态图里，
      //   气泡明显收在整条上下边里面。
      top: BUBBLE_INSET,
      bottom: BUBBLE_INSET,
    },
    tabItemGlass: {
      borderRadius: radius.pill,
      overflow: 'visible',
    },
    /** 铺在气泡里的原生玻璃材质层（非交互，只画不吃手势） */
    tabBubbleGlass: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    /** 静止态：一层很淡的灰（亮）/ 白釉（深），不描边、不投影 */
    tabBubbleInner: {
      flex: 1,
      borderRadius: radius.pill,
      backgroundColor: color.tabBubble,
    },
    /**
     * 按下态：叠在静止层上的那颗"玻璃珠"。
     * `opacity` 由 `capsulePress` 驱动（0 → 1），和放大是同一条弹簧。
     */
    tabBubbleLit: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: radius.pill,
      backgroundColor: color.tabBubbleLit,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.tabBubbleBorder,
      // ★ 阴影只给 iOS：Android 的 `elevation` 会**抬高绘制层级**，
      //   绝对定位的气泡一旦带上 elevation 就会盖到图标/文字上面去。
      ...(Platform.OS === 'ios'
        ? {
            shadowColor: '#000000',
            shadowOpacity: 0.20,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 4 },
          }
        : null),
    },
    tab: {
      alignItems: 'center',
      paddingHorizontal: 28,
      // 图标 + 文字比原来一行字高，纵向留白收一点，整条不至于太厚
      paddingTop: 7,
      paddingBottom: space.sm,
    },
    tabText: { marginTop: 3, fontSize: 12, lineHeight: 14, fontWeight: '500' },
    tabTextLit: { fontWeight: '700' },
  });

export default App;
