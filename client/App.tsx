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
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
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
import { isOnHorizontalRow } from './src/components/horizontalRow';
import { CategoryScreen } from './src/screens/CategoryScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ThemeProvider, radius, space, useTheme } from './src/theme';
import {
  LiquidGlassView,
  isLiquidGlassSupported,
} from '@callstack/liquid-glass';
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
  const realGlass =
    Platform.OS === 'ios' && (isLiquidGlassSupported as boolean);
  /**
   * 本机拿到的是**真·液态玻璃**（iOS 26+）吗。
   *
   * 真玻璃是**自己会折光**的材质，跟"模糊 + 垫一层半透明底"是两套做法：
   * 背后再垫一层半透明黑，那层会被材质一并采样，玻璃就糊成一块板了。
   * 所以它同时决定两件事：Tab 栏底色要不要透明、玻璃要不要开交互。
   */
  const liquidGlass = glassOn && LIQUID_GLASS_AVAILABLE;
  const styles = useMemo(
    () => makeStyles(color, glassOn, liquidGlass, insets.bottom),
    [color, glassOn, liquidGlass, insets.bottom],
  );
  const [tab, setTab] = useState<Tab>('home');
  const [route, setRoute] = useState<Route>({ name: 'tabs' });
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
   *     · `capsulePress` → **选中胶囊**放大得更多（纵向 1 → 1.16），
   *       且**慢半拍**（`delay`）—— 观感是"条先鼓起、胶囊再顶出来"，
   *       顶出来的那一截正好越过 tab 条的上下边（见 `TAB_CAPSULE_LIFT`）
   *
   *   ★ 弹簧**故意用不同参数**：条那条快而硬（跟手），胶囊那条慢而弹
   *     （"液体"那点黏滞感）。两个都关掉 native driver 会踩坑，
   *     所以：条用 native（纯 transform），胶囊留着 JS driver ——
   *     同一个视图上不能混，这里正好是两个视图。
   *
   *   真·液态玻璃（iOS 26）那侧，**整条**的系统原生扩张照旧由
   *   `UIGlassEffect.isInteractive` 负责；胶囊这一层是我们自己补的，
   *   两者叠起来才是"条 + 胶囊"两层都动。
   */
  const tabPress = useRef(new Animated.Value(0)).current;
  /** 胶囊那一层（慢半拍、幅度更大） */
  const capsulePress = useRef(new Animated.Value(0)).current;

  const setTabHeld = useCallback(
    (held: boolean) => {
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
    outputRange: [1, 1.04],
  });

  /** 胶囊：按压时**明显越过** tab 条上下边（ 用户报"按压 expand 的 feeling 缺失"） */
  const capsuleScaleY = capsulePress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.22],
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
   * 胶囊的**宽度** —— 单独一条值才做得动"流淌"那一下：
   * 切换时先把宽度抻长（补齐两格之间的距离），位置挪过去再收回来。
   * ★ 只给宽度一条值不够，左右两条边要能**分别**动，见 `settleCapsule`。
   */
  /** 胶囊左边缘当前该在哪 —— 拖拽要从这个值算起 */
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

  /**
   * ★★ 真·液态玻璃下"按的是哪个 Tab" —— 从**落点 x** 反推。
   *
   *   为什么非要这么绕：`UIGlassEffect` 的交互反馈（按住扩张 + 起高光）只在
   *   **触摸打中玻璃自己**时才动。以前按钮垫在玻璃上面、命中优先级更高，
   *   手指永远先落在按钮上 —— 玻璃收不到触摸，那个反馈就只出现在胶囊空白处，
   *   按钮上只能靠一层 JS 弹簧糊弄（一眼假）。
   *
   *   现在按钮退成纯展示层（`TabButton` 的 `passive`），触摸落到玻璃上 →
   *   **系统原生动画**；顺便拿 `locationX` 算按的是哪一项。
   *   `locationX` 是相对**触摸目标**（那层玻璃）的坐标，而玻璃与胶囊同尺寸
   *   （`styles.tabBar` 没有 padding，玻璃是 `inset 0` 的绝对定位），
   *   所以它的 x 就等于在胶囊里的 x，跟 `tabRects`（胶囊内坐标）同一套。
   */
  const pressTabAt = useCallback(
    (x: number) => {
      if (!tabRects.length) return;
      // 先找落点**所在**的那一项
      let hit = tabRects.findIndex(r => x >= r.x && x <= r.x + r.width);
      if (hit < 0) {
        // 落在边界外（手指滑出按钮一点点）就按最近的**中心**算，
        // 别让这一下白点
        hit = 0;
        for (let i = 0; i < tabRects.length; i += 1) {
          const center = tabRects[i].x + tabRects[i].width / 2;
          const best = tabRects[hit].x + tabRects[hit].width / 2;
          if (Math.abs(center - x) < Math.abs(best - x)) hit = i;
        }
      }
      goToTab(TABS[hit].id);
    },
    [tabRects, goToTab],
  );

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
      if (!animated) {
        capsuleL.setValue(rect.x);
        return;
      }
      // ★ 纯平移（不要拉长）—— 用户报"先抻长、滑过去再收的是错的"
      Animated.spring(capsuleL, {
        toValue: rect.x,
        useNativeDriver: false,
        friction: 9,
        tension: 80,
      }).start();
    },
    [tabRects, capsuleL],
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
    },
    [tabRects, pageX, capsuleL, width],
  );

  // 点 Tab 切过去时，胶囊跟着滑
  useEffect(() => {
    settleCapsule(tabIndexOf(tab));
  }, [tab, tabIndexOf, settleCapsule]);

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
  const tabBarPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => {
          const first = tabRects[0]?.x ?? 0;
          const last = tabRects[tabRects.length - 1]?.x ?? 0;
          const stride = (tabRects[1]?.x ?? first) - first || 1;
          const next = Math.min(
            last,
            Math.max(first, capsuleTarget.current + g.dx),
          );
          // ★ 页面同步跟手 —— 胶囊在 Tab 空间走了多少，页面就在页空间走多少
          syncTo((next - first) / stride);
        },
        onPanResponderRelease: (_e, g) => {
          if (!tabRects.length) return;
          // 按胶囊**当前停在哪**找最近的 Tab，比拿位移除以宽度准
          const moved = capsuleTarget.current + g.dx;
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
        onPanResponderTerminate: () => settleCapsule(tabIndexOf(tab)),
      }),
    [tabRects, tab, goToTab, settleCapsule, settleTo, syncTo, tabIndexOf],
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
        if (tab !== 'home') {
          goToTab('home');
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
   * 玻璃材质的**明暗跟应用主题走**（不是系统外观）——
   * 跟 `GlassBox` 那套约定一致：系统浅色 + App 深色时不指定，
   * 玻璃会按浅色材质渲染，糊在深色页面上就是一块刺眼的亮。
   */
  const glassScheme: 'light' | 'dark' =
    color.statusBar === 'dark-content' ? 'light' : 'dark';

  /**
   * 选中胶囊 —— 跟着手指走的那一颗。
   *
   * ★ 两端共用**同一个壳**（`styles.tabIndicator` + 同一组动画值），
   *   只有**里子**不同：
   *     · iOS 26 真材质 → 塞一颗 `LiquidGlassView`（会跟整条融成一块）
   *     · 其余（Android / iOS 26 以下）→ 原来那层实心填充
   *   这样位置、滑动幅度、"探出整条"的尺度两端**天然一致**，不会各调各的。
   *
   * ★ 按住的"扩张"分两层：整条 1.04（`tabScale`，仅非真玻璃），
   *   这一颗胶囊 1.22 / 1.05（`capsuleScale*`，两端都有）——
   *   于是胶囊顶出去的那一截会**越过整条的上下边**。
   */
  const capsule =
    tabRects.length === TABS.length ? (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.tabIndicator,
          {
            width: tabRects[tabIndexOf(tab)]?.width ?? 0,
            transform: [
              { translateX: capsuleL },
              { scaleX: capsuleScaleX },
              { scaleY: capsuleScaleY },
            ],
          },
        ]}
      >
        {realGlass ? (
          /* ★ `LiquidGlassView` **没有 `cornerRadius` 属性** —— 它从自己
             `style` 的 `borderRadius` 取圆角（见 `LiquidGlassView.mm` 的
             `layoutSubviews`：`_view.layer.cornerRadius = self.layer.cornerRadius`）。
             所以圆角写在这里，不写属性。 */
          <LiquidGlassView
            style={[StyleSheet.absoluteFill, { borderRadius: radius.pill }]}
            effect="regular"
            colorScheme={glassScheme}
            tintColor={color.glassCapsule}
          />
        ) : (
          <View style={styles.tabIndicatorInner} />
        )}
      </Animated.View>
    ) : null;

  /** 三个 Tab 按钮。两端渲染的是同一份 —— 免得改了一边忘了另一边 */
  const tabButtons = TABS.map((item, index) => (
    <TabButton
      key={item.id}
      label={item.label}
      active={tab === item.id}
      passive={liquidGlass}
      onPress={() => goToTab(item.id)}
      onPressIn={() => setTabHeld(true)}
      onPressOut={() => setTabHeld(false)}
      onLayout={e => handleTabLayout(index, e)}
    />
  ));

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
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.header}>
          <View style={styles.headerMain}>
            <Text style={styles.brand}>小包子影视</Text>
          </View>
          <Pressable onPress={() => setRoute({ name: 'settings' })} hitSlop={8}>
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
            <View style={{ width }}>
              {visited.home ? <HomeScreen onOpen={openSeries} /> : null}
            </View>
            <View style={{ width }}>
              {visited.category ? <CategoryScreen onOpen={openSeries} /> : null}
            </View>
            <View style={{ width }}>
              {visited.search ? <SearchScreen onOpen={openSeries} /> : null}
            </View>
          </Animated.View>
        </View>

        {/* 悬浮玻璃 Tab 栏：居中、不铺满、离底边留一点 */}
        <View style={styles.tabBarWrap} pointerEvents="box-none">
          {/* 拖拽手势挂在这一层：内容区不受影响，板块该滚滚 */}
          <View {...tabBarPan.panHandlers}>
            {/*
              ★★ 为什么**不用** `LiquidGlassContainerView`（踩过，别再走回去）：

                 `UIGlassContainerEffect` 是**合并**语义 —— 把多颗玻璃融成
                 **一个形状**。我们的胶囊整颗都躺在整条里面，融完就等于整条本身，
                 **什么都看不见**（用户 2026-10-16 报「内部的胶囊看不到了」）。
                 而且它在 contentView 里排在整条**前面**，也就是压在整条玻璃
                 **下面**，双重地被吃掉。

                 现在改成跟 iOS 26 以下那一支**同一个结构**：胶囊是整条玻璃的
                 **子节点** —— 于是它画在整条玻璃材质**上面**、三个按钮**下面**，
                 不会被谁盖住。探出去的那一截靠 `capsuleScale*`（两端同一套）。

                 ★ 但光有玻璃还不够：胶囊跟整条是**同一份材质**，叠在一起看不出
                   差别。所以给胶囊那颗玻璃上了 `tintColor`（见 `capsule`），
                   让它明确地亮出来。

                 ★ 这一支**不叠** JS 弹簧（`tabScale`）：系统的按压反馈是真的
                   （整条会鼓），再加一层缩放就是双重放大，反而更假。
            */}
            {realGlass ? (
              <Pressable onPress={e => pressTabAt(e.nativeEvent.locationX)}>
                {/* ★ 不传 `cornerRadius`：`LiquidGlassView` 没有这个属性，
                    圆角由 `styles.tabBar` 的 `borderRadius` 带过去
                    （见 `LiquidGlassView.mm` 的 `layoutSubviews`）。
                    ★★ 触摸面 = **玻璃**：按钮那一层已退成纯展示（`passive`），
                    所以手指一定先打在玻璃上 —— `UIGlassEffect(isInteractive)`
                    的扩张 / 高光**真的会动**；RN 的 responder 再从玻璃那层
                    冒泡到这个 `Pressable`，用 `locationX` 反推按的是哪一项。 */}
                <LiquidGlassView
                  style={styles.tabBar}
                  interactive
                  effect="regular"
                  colorScheme={glassScheme}
                >
                  {capsule}
                  {tabButtons}
                </LiquidGlassView>
              </Pressable>
            ) : (
              /* ★ 这一层 `Animated.View`（JS 弹簧回弹）只在没有真玻璃时才用：
                  那种情况下按钮垫在玻璃上面、玻璃收不到触摸，全靠它补手感。 */
              <Animated.View style={{ transform: [{ scale: tabScale }] }}>
                <Pressable onPress={e => pressTabAt(e.nativeEvent.locationX)}>
                  <GlassBox
                    style={styles.tabBar}
                    cornerRadius={radius.pill}
                    interactive
                  >
                    {capsule}
                    {tabButtons}
                  </GlassBox>
                </Pressable>
              </Animated.View>
            )}
          </View>
        </View>
      </SafeAreaView>
      {overlay}
    </>
  );
}

/** 底部 Tab：选中项文字高亮 + 下面一个小点 */
function TabButton({
  label,
  active,
  passive,
  onPress,
  onPressIn,
  onPressOut,
  onLayout,
}: {
  label: string;
  active: boolean;
  /**
   * ★ **纯展示**：只负责画，完全不接收触摸。
   *
   *   iOS 26 的真玻璃必须"手指打在玻璃自己身上"才有系统的按压反馈，
   *   所以这一层要让开：触摸穿透到下面的玻璃，
   *   由外面那层 `Pressable` 从落点反推按的是哪一项（见 `pressTabAt`）。
   *
   *   ★ 用 `pointerEvents="none"` 而不是让它可点但不管事 ——
   *     前者在 iOS 上直接把 `userInteractionEnabled` 置 false，
   *     触摸才**真的**会落到玻璃上。
   */
  passive?: boolean;
  onPress: () => void;
  /** 按住 / 松开 —— 给外面那层胶囊做按压回弹用（真玻璃下用不到） */
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}): React.JSX.Element {
  const { color } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);

  const content = (
    <>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
      <View style={[styles.tabDot, active && styles.tabDotActive]} />
    </>
  );

  if (passive) {
    return (
      <View style={styles.tab} pointerEvents="none" onLayout={onLayout}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onLayout={onLayout}
    >
      {content}
    </Pressable>
  );
}

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
    tabIndicator: {
      position: 'absolute',
      left: 0,
      top: space.xs,
      bottom: space.xs,
    },
    tabIndicatorInner: {
      flex: 1,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceStrong,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.glassBorder,
    },
    tab: {
      alignItems: 'center',
      paddingHorizontal: space.xl,
      paddingVertical: space.md,
    },
    tabText: { color: color.textDim, fontSize: 15 },
    tabTextActive: { color: color.text, fontWeight: '700' },
    tabDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      marginTop: 3,
      backgroundColor: 'transparent',
    },
    tabDotActive: { backgroundColor: color.accent },
  });

export default App;
