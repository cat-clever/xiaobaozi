import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Image,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Pressable } from '../components/FocusablePressable';
import { isRemoteMode } from '../tv/inputMode';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import type { VideoRef } from 'react-native-video';
import { detail as loadDetail } from '../api/aggregator';
import * as s1 from '../api/source1';
import {
  castSourceForSource1,
  castSourceForSource2Candidate,
  resolveSource1,
  resolveSource2Candidate,
  source2Candidates,
} from '../media/streamResolver';
import type { CastSource } from '../media/streamResolver';
import {
  shutdownMediaServer,
  startRelayKeepAlive,
  stopRelayKeepAlive,
} from '../media/mediaServer';
import {
  discoverDlnaDevices,
  dlnaCast,
  dlnaPause,
  dlnaPlay,
  dlnaStatus,
  dlnaStop,
} from '../cast/dlna';
import { CastSheet } from '../components/CastSheet';
import type { ActiveCast } from '../components/CastSheet';
import type { CastDevice, CastTransportState } from '../cast/types';
import {
  applyBrightness,
  applyOrientation,
  setPipAspectRatio,
} from '../media/screenControl';
import { TAB_BAR_SPACE, radius, space, useTheme } from '../theme';
import { getMiniSizeIdx, saveMiniSizeIdx } from '../utils/storage';
import type { Palette } from '../theme';
import type {
  PlayLine,
  ResolvedMediaStream,
  VodDetail,
  VodItem,
} from '../types/schema';

interface Props {
  /** 从列表里点进来的那张卡片 —— 详情由播放页自己去拉 */
  item: VodItem;
  /** 播第几集（0 起）。从列表进来时是第 1 集 */
  episodeIndex: number;
  /** 小窗模式：缩成角落里的悬浮窗，继续播 */
  mini?: boolean;
  /** 全屏时按返回 —— 收成小窗（不结束播放） */
  onBack: () => void;
  /** 小窗被点击 —— 展开回全屏 */
  onExpand: () => void;
  /** 小窗上的关闭 —— 结束这次播放 */
  onClose: () => void;
}

/** 控制条自动隐藏的等待时间 */
const CHROME_HIDE_MS = 4000;
/** 双击快进的步长（秒） */
const SKIP_SECONDS = 10;
/** 竖向滑动多少屏高走完整个音量/亮度行程 */
const SWIPE_RANGE = 0.7;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 按住屏幕左 / 右半边 = 快退 / 快进，倍速固定 **2 倍**。
 *
 * ★ 快进用**播放速率**：把 `rate` 提到 2，画面是平滑的 2 倍速（还带声音）。
 * ★ 快退**没有负的播放速率**（iOS 的 AVPlayer 对 HLS 基本不认负 rate，
 *   Android 的 ExoPlayer 干脆不支持），只能按住时**定时往回 seek** ——
 *   暂停 + 每 `HOLD_REWIND_TICK_MS` 往后跳一小步，净效果同样是 2 倍速。
 */
const HOLD_RATE = 2;
/** 按住多久才算"按住快进/快退"（而不是单击 / 双击） */
const HOLD_DELAY_MS = 320;
/** 快退时每隔多久往回跳一步 */
const HOLD_REWIND_TICK_MS = 200;

/** 小窗离屏幕边缘的留白 */
const MINI_MARGIN = 12;

/** 小窗三档的宽度比例（相对"最大档"）。默认中档 —— 小了看不清，大了挡内容 */
const MINI_RATIOS = [
  { label: '小', ratio: 0.42 },
  { label: '中', ratio: 0.62 },
  { label: '大', ratio: 1 },
] as const;

/** 最大档：**比竖屏宽度小一点**（留出左右边距，别顶到屏幕边） */
const miniMaxWidth = (screenWidth: number): number =>
  Math.round(screenWidth - MINI_MARGIN * 2 - 16);

const miniHeightOf = (width: number): number => Math.round((width * 9) / 16);

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * 播放页（参照 B 站）。
 *
 * 布局：
 *   - **竖屏**：视频贴顶占 16:9，下面接标题与选集网格（B 站那种）
 *   - **横屏**：视频铺满全屏，选集 / 线路 / 倍速走抽屉
 *
 * 手势：单击显隐控制条、双击左右快进 10 秒、竖向滑动左半屏调亮度 / 右半屏调音量、
 * 横向滑动拖进度。
 *
 * ★ 取流一律走本地媒体服务（见 `media/streamResolver.ts`）——
 *   播放器只认一个 `http://127.0.0.1:...` 地址，不再自己带请求头。
 */
/**
 * 播放页。
 *
 * ★ 详情和播放**合成了一屏** —— 从列表点进来直接起播第 1 集，
 *   剧集信息与选集就在竖屏视频下面那块面板里。
 *   原先"详情页 → 点选集 → 播放页"两屏是重复的，操作上也多一跳。
 *
 * 这一层只负责**把详情拉回来**；拉回来之后交给 `PlayerView` 渲染，
 * 那边 `detail` 是必填的，内部不用到处判空。
 */
export function PlayerScreen({
  item,
  episodeIndex,
  mini = false,
  onBack,
  onExpand,
  onClose,
}: Props): React.JSX.Element {
  const { color } = useTheme();
  const [detail, setDetail] = useState<VodDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 用户选中的**季**（源2 多季的剧才有）。
   *
   * ★ 上游把每一季当**独立的剧**（独立 sid），所以这里存的是 sid 而不是"第几季"。
   *
   * ★ 连着 `item.id` 一起存是有意的：播放页是**常驻实例**（App.tsx 里切剧不重新挂载），
   *   只存 sid 的话，切剧那次 render 会拿着上一部剧的季 sid 去拉详情。
   *   这样写是纯派生的 —— item 一变，seasonSid 立刻回到 null，没有中间态。
   */
  const [pickedSeason, setPickedSeason] = useState<{ itemId: string; sid: string } | null>(null);
  const seasonSid = pickedSeason && pickedSeason.itemId === item.id ? pickedSeason.sid : null;

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    // 切了季就拿那一季的 sid 重新拉 —— 源2 的 detail() 内部会剥掉 `s2_` 前缀
    loadDetail(item.sourceId, seasonSid ? `s2_${seasonSid}` : item.id)
      .then(d => {
        if (alive) setDetail(d);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [item, seasonSid]);

  if (error || !detail) {
    return (
      <View style={[shell.root, { backgroundColor: color.bg }]}>
        {error ? (
          <>
            <Text style={shell.text}>{item.title}</Text>
            <Text style={shell.error}>{error}</Text>
            <Pressable onPress={onClose} style={shell.btn} hitSlop={8}>
              <Text style={shell.btnText}>返回</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={color.accent} />
        )}
      </View>
    );
  }

  return (
    <PlayerView
      // ★ 换了季就换 key 重挂 —— 新的一季等于另一部剧，
      //   播放位置 / 线路 / 清晰度这些内部状态必须整个重置，不能沿用上一季的。
      key={seasonSid ?? 'self'}
      detail={detail}
      // 切季回到第 1 集（季与季的集号不对应，沿用进来的下标会指错集）
      episodeIndex={seasonSid ? 0 : episodeIndex}
      mini={mini}
      onSelectSeason={sid => setPickedSeason({ itemId: item.id, sid })}
      onBack={onBack}
      onExpand={onExpand}
      onClose={onClose}
    />
  );
}

/** 详情拉回来之后的实际播放界面 —— `detail` 在这里一定不为空 */
function PlayerView({
  detail,
  episodeIndex,
  mini = false,
  onSelectSeason,
  onBack,
  onExpand,
  onClose,
}: {
  detail: VodDetail;
  episodeIndex: number;
  mini?: boolean;
  /** 源2 多季的剧：切季（传那一季的 sid） */
  onSelectSeason?: (sid: string) => void;
  onBack: () => void;
  onExpand: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { color } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  /** 电视/盒子：永远横屏，**绝不请求竖屏** —— 电视不会跟着转，只会让画面横着显示 */
  const isTV = Platform.isTV;
  const setOrientation = useCallback(
    (mode: 'portrait' | 'landscape') => {
      if (isTV) return;
      applyOrientation(mode);
    },
    [isTV],
  );

  /**
   * ★ 播放页是**全屏铺**的（不走 SafeAreaView），必须自己让开安全区 ——
   *   不然竖屏时刘海 / 状态栏会压住视频和控制条。
   *
   *   竖屏：视频整块往下挪 `insets.top`，从状态栏下面开始（B 站那种）
   *   横屏：视频仍铺满，但上下控制条各自让开对应的安全区
   */
  const insets = useSafeAreaInsets();
  const topPad = landscape ? insets.top : 0;
  const bottomPad = landscape ? insets.bottom : 0;

  const videoRef = useRef<VideoRef>(null);

  const [epIdx, setEpIdx] = useState(episodeIndex);
  const [stream, setStream] = useState<ResolvedMediaStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);

  // 源1：线路表；源2：清晰度走 s2Quality，拿回来的是**分段列表**
  const [s1Lines, setS1Lines] = useState<PlayLine[]>([]);
  /**
   * 源1 的**原始**线路表。
   *
   * ★ `s1Lines` 是筛过"可播"的那份，投屏准入要看原始 `kind`
   *   （直投还是转发由它决定，见 `streamResolver` 的 `castSourceForSource1`）。
   */
  const [s1RawLines, setS1RawLines] = useState<PlayLine[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  /**
   * 源2 的清晰度档位。
   *
   * ★ 默认取**最高的一档免费清晰度**（也就是高清 720P）：
   *   - 实测不传 `sq` 时上游也是给这一档，显式选上只是让 UI 对得上
   *   - 会员档位（蓝光）已经在 `s2.detail()` 里滤掉了 ——
   *     手里没账号时请求它们会被**静默降级到最差的标清**
   *
   * 初值直接从 detail 里算，不走 effect —— 走到 effect 会先按 null 发一次请求再重发。
   */
  const [s2Quality, setS2Quality] = useState<number | null>(() => {
    const list = detail.qualities ?? [];
    return list.length ? Math.max(...list.map(q => q.value)) : null;
  });
  const [s2Segments, setS2Segments] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [segIdx, setSegIdx] = useState(0);

  // ---------- 投屏 ----------
  const [castOpen, setCastOpen] = useState(false);
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  const [castScanning, setCastScanning] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  /** 点了但还没投上的那一台 —— 那一行转圈 */
  const [castConnectingId, setCastConnectingId] = useState<string | null>(null);
  const [castActive, setCastActive] = useState<ActiveCast | null>(null);
  const [castTransport, setCastTransport] = useState<CastTransportState | null>(null);
  /** 投屏用的那份地址。转发模式底下挂着一个本地会话，停投时必须关掉 */
  const castSourceRef = useRef<CastSource | null>(null);

  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  // 亮度只存 ref —— 界面不显示它，只有手势在改

  const [chrome, setChrome] = useState(true);
  /**
   * ★ 小窗出现时把焦点交给它（一次性）。
   *
   *   回到主页后，小窗是绝对定位在角落的一块 View，默认不可聚焦 —— 遥控器
   *   按方向键根本找不到它，用户就「回不去播放页」（2026-10-22 反馈）。
   *   下面给小窗盖一层可聚焦的 Pressable，出现时请求一次焦点，按确定即展开。
   *
   *   ★ 与 Tab 那边同一个坑：`hasTVPreferredFocus` 一直挂着会在每次重渲染时
   *     抢焦点，所以拿到焦点后立刻撤掉。
   */
  const [miniFocusPending, setMiniFocusPending] = useState(false);
  useEffect(() => {
    if (mini) setMiniFocusPending(true);
  }, [mini]);
  /** 播放页控件出现时把焦点给「返回」—— 同样只请求一次（同上一个坑）。 */
  const [playerFocusPending, setPlayerFocusPending] = useState(true);
  useEffect(() => {
    if (!mini) setPlayerFocusPending(true);
  }, [mini]);
  const [drawer, setDrawer] = useState<'none' | 'episode' | 'line' | 'speed'>(
    'none',
  );
  /**
   * 选集抽屉打开时把焦点交给当前集 —— 只请求一次。
   *
   *   `hasTVPreferredFocus` 一直挂着的话，播放器每 500ms 一次的位置更新
   *   （重渲染）都会把焦点抢回当前集，用户根本没法在选集列表里移动。
   */
  const [episodeFocusPending, setEpisodeFocusPending] = useState(false);
  useEffect(() => {
    setEpisodeFocusPending(drawer === 'episode');
  }, [drawer]);
  const [hint, setHint] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** 是不是正处在**系统画中画**里（浮到桌面上那种，跟应用内小窗不是一回事） */
  const [inPip, setInPip] = useState(false);
  /**
   * 按住快进 / 快退的方向。
   *
   * ★ 只在"按住不动"时才置位 —— 拖动进度、上下滑调音量/亮度都不算。
   *   渲染时用它把 `rate` 提到 2 倍（快进），或者暂停 + 定时往回 seek（快退）。
   */
  const [holdDir, setHoldDir] = useState<'none' | 'fwd' | 'bwd'>('none');

  const episode = detail.episodes[epIdx];

  /**
   * ★★ 手势里要读的这些值**一律走 ref**，不要放进 PanResponder 的依赖里。
   *
   *   `onProgress` 每 500ms 更新一次 `position`，如果 PanResponder 是用
   *   `useMemo(..., [position, ...])` 建的，它就会**每 500ms 重建一次** ——
   *   触摸在重建的瞬间被丢掉，表现就是"刚进页面点得动，一开始播就点不动了"。
   *   所以 PanResponder 只建一次，动态值全部从 ref 读。
   */
  const durationRef = useRef(0);
  const positionRef = useRef(0);
  const volumeRef = useRef(1);
  const brightnessRef = useRef(0.6);
  const chromeRef = useRef(true);
  /** 按住快退时要"松手是否恢复播放"，所以得知道按住之前是不是暂停着 */
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  /** 进度：state 与 ref 一起写，手势里读到的永远是最新值 */
  const putPosition = useCallback((value: number) => {
    positionRef.current = value;
    setPosition(value);
  }, []);

  const putDuration = useCallback((value: number) => {
    durationRef.current = value;
    setDuration(value);
  }, []);

  // ---------- 控制条自动隐藏 ----------
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpChrome = useCallback(() => {
    chromeRef.current = true;
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // ★ 遥控器模式下**不自动收起**：收起后焦点会掉回背景（Tab / 设置），
      //   用户按方向键就像"播放器不接受焦点"。
      if (isRemoteMode()) return;
      chromeRef.current = false;
      setChrome(false);
    }, CHROME_HIDE_MS);
  }, []);

  /** 单击：显示中就收起，收起中就显示 */
  const toggleChrome = useCallback(() => {
    if (chromeRef.current) {
      chromeRef.current = false;
      setChrome(false);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    } else {
      bumpChrome();
    }
  }, [bumpChrome]);

  const flashHint = useCallback((text: string | null) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (text) hintTimer.current = setTimeout(() => setHint(null), 900);
  }, []);

  useEffect(() => {
    bumpChrome();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [bumpChrome]);

  // ---------- 解析线路 ----------
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setStream(null);
    putPosition(0);
    putDuration(0);
    setSegIdx(0);
    setS2Segments([]);

    void (async () => {
      try {
        if (detail.sourceId === 's1') {
          const lines = await s1.playLinesFor(detail.vodId, episode);
          if (!alive) return;
          const usable = lines.filter(l => l.playable && !l.note);
          setS1Lines(usable);
          setS1RawLines(lines);
          const resolved = await resolveSource1(lines, usable[pickIdx] ?? null);
          if (alive) setStream(resolved);
        } else {
          // ★ 源2 这里拿到的是**分段列表**（一集可能被切成十几段 mp4），不是清晰度。
          //   清晰度由 s2Quality 走 `sq` 参数决定。
          const items = (
            await source2Candidates(detail.vodId, episode, {
              quality: s2Quality,
            })
          ).filter(it => it.playUrl);
          if (!alive) return;
          if (!items.length)
            throw new Error('没有拿到播放地址（该集可能受限或上游抖动）');
          setS2Segments(items);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [detail, episode, epIdx, pickIdx, s2Quality, putPosition, putDuration]);

  // 源2：把当前这一段解析成可播放地址。换段只走这里，不重新拉列表
  useEffect(() => {
    if (detail.sourceId !== 's2') return undefined;
    const item = s2Segments[segIdx];
    if (!item) return undefined;

    let alive = true;
    resolveSource2Candidate(item)
      .then(resolved => {
        if (alive) setStream(resolved);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [detail.sourceId, s2Segments, segIdx]);

  // 换线路/换集/退出页面时关掉上一个播放会话
  useEffect(() => {
    const current = stream;
    return () => {
      void current?.dispose?.();
    };
  }, [stream]);

  // ---------- 投屏 ----------

  /** 扫一遍局域网。**扫描期间再点刷新就忽略**，别叠着扫 */
  const scanCastDevices = useCallback(async () => {
    setCastScanning(true);
    setCastError(null);
    try {
      const list = await discoverDlnaDevices(4000);
      setCastDevices(list);
    } catch (err) {
      setCastError(err instanceof Error ? err.message : String(err));
    } finally {
      setCastScanning(false);
    }
  }, []);

  const openCast = useCallback(() => {
    setCastOpen(true);
    void scanCastDevices();
  }, [scanCastDevices]);

  /** 把当前这一集投到某台设备上 */
  const startCast = useCallback(
    async (device: CastDevice) => {
      setCastConnectingId(device.id);
      setCastError(null);
      let source: CastSource | null = null;
      try {
        // ★ 准入在 `streamResolver` 里判：能直投的直投，其余走手机转发（§5.5.3）
        source =
          detail.sourceId === 's1'
            ? await castSourceForSource1(s1RawLines, s1Lines[pickIdx] ?? null)
            : await castSourceForSource2Candidate(s2Segments[segIdx] ?? {});

        const title = `${detail.name} ${episode?.title ?? ''}`.trim();
        // ★★ 转发模式下流经手机：投屏期间必须让进程活着，否则息屏/切后台
        //   一被系统冻结，电视端立刻断流（2026-10-20 真机定位）。
        //   直投不经过我们，不用起。
        //   ★ 起不来也照投 —— 只是界面要如实提示"别息屏"。
        const keepAlive = source.direct ? false : await startRelayKeepAlive();
        await dlnaCast(device, source.url, title);

        // 投上了才把旧的那份收掉（失败的话旧的还在用，别提前拆）
        await castSourceRef.current?.dispose?.();
        castSourceRef.current = source;
        setCastActive({
          device,
          direct: source.direct,
          lineName: source.lineName,
          keepAlive,
          // 诊断用：电视不出画面时，用户能拿浏览器验证这个地址通不通
          url: source.url,
        });
        // 本地这路停下来 —— 同一个片子两边一起放没有意义
        setPaused(true);
      } catch (err) {
        // ★ 失败要把**这次**可能已经起来的转发会话收掉，别漏一个后台服务
        await source?.dispose?.();
        // 已经有投屏在跑的话，保活是给它的，不能停
        if (!castActive) await stopRelayKeepAlive();
        setCastError(err instanceof Error ? err.message : String(err));
      } finally {
        setCastConnectingId(null);
      }
    },
    [detail, s1RawLines, s1Lines, pickIdx, s2Segments, segIdx, episode, castActive],
  );

  const stopCast = useCallback(async () => {
    const active = castActive;
    const source = castSourceRef.current;
    castSourceRef.current = null;
    setCastActive(null);
    setCastTransport(null);
    try {
      if (active) await dlnaStop(active.device);
    } catch {
      // 设备可能已经离线/关机 —— 本地该收的照收，不因为远端没响应就卡住
    }
    await source?.dispose?.();
    await stopRelayKeepAlive();
    setPaused(false);
  }, [castActive]);

  const toggleCastPlay = useCallback(async () => {
    if (!castActive) return;
    const playing = castTransport?.state === 'playing';
    try {
      if (playing) await dlnaPause(castActive.device);
      else await dlnaPlay(castActive.device);
    } catch (err) {
      setCastError(err instanceof Error ? err.message : String(err));
    }
  }, [castActive, castTransport]);

  /**
   * 投屏期间每 4 秒问一次设备状态（遥控器要知道"现在是播还是停"）。
   *
   * ★ 问不到就**保持上一次的状态**，别把 UI 打空 —— 电视响应慢是常态。
   */
  useEffect(() => {
    if (!castActive) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const state = await dlnaStatus(castActive.device);
        if (alive) setCastTransport(state);
      } catch {
        // 保持上一次
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [castActive]);

  // 离开播放页：转发会话与保活都要收掉（不然本地服务/前台服务会一直开着）
  useEffect(
    () => () => {
      void castSourceRef.current?.dispose?.();
      void stopRelayKeepAlive();
    },
    [],
  );

  // 离开播放页就把本地媒体服务整个收掉（文档 §6.3：仅播放期间存活）
  useEffect(() => () => void shutdownMediaServer(), []);

  // 退出播放页时把方向还原成竖屏
  useEffect(
    () => () => {
      setOrientation('portrait');
    },
    [setOrientation],
  );

  /**
   * ★ 收成小窗时把屏幕转回竖屏。
   *
   * 原来是"全屏"按一下切横屏，但**没有任何人把它转回来** ——
   * 在横屏下点返回收成小窗，整个 App 就一直是横的，而小窗本身是
   * 竖屏下的形态（右下角一块），横着看完全不对。
   *
   * 放在这里而不是按钮的回调里，是因为**进小窗有两条路** ——
   *   1. 播放页左上角那个「‹」返回
   *   2. Android 的硬件返回键（App.tsx 里直接 setMini(true)）
   * 挂在 `mini` 上两边都能兜住。
   */
  useEffect(() => {
    if (!mini) return;
    setOrientation('portrait');
    setFullscreen(false);
    // ★ 抽屉也要收掉 —— 小窗的 stage 是**绝对定位**的（脱离文档流），
    //   抽屉要是还开着，就成了唯一的流内元素，被顶到屏幕最上面去。
    setDrawer('none');
    // 按钮是"点一下才出来"的，进小窗时提示一句，免得找不到
    bumpChrome();
    flashHint('点一下小窗显示按钮');
  }, [mini, bumpChrome, flashHint, setOrientation]);

  /**
   * ★★ 「退出全屏」要有**唯一一份**实现。
   *
   * ★ 放在这里（而不是挨着全屏按钮）是因为下面的返回键处理要用它 ——
   *   effect 里引用的东西必须在它前面就定义好。
   */
  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    setOrientation('portrait');
    flashHint('已退出全屏');
  }, [flashHint, setOrientation]);

  /**
   * ★★ 返回的语义分两层：
   *
   *   1. **横屏（或按过全屏）时先退出全屏** —— 回到**竖屏的播放页**；
   *   2. 否则才收成小窗（不打断播放）。
   *
   * 之前只有第 2 条：横屏下按「‹」/ 返回键，屏幕转回竖屏的同时播放器
   * 缩成了小窗 —— 人一眼看到的是"首页 + 角落里一个小窗"，而不是回到播放页。
   * 那一下跳得太狠了，退全屏本来只是**这一层**的事。
   */
  const handleBack = useCallback(() => {
    // ★ TV 没有"退出全屏回竖屏"这一步：全屏（详情收起）时先退全屏，
    //   否则直接收起播放页，避免请求竖屏后整个界面横着显示（2026-10-21 反馈）。
    if (isTV) {
      if (fullscreen) {
        setFullscreen(false);
        return;
      }
      onBack();
      return;
    }
    if (fullscreen || landscape) {
      exitFullscreen();
      return;
    }
    onBack();
  }, [isTV, fullscreen, landscape, exitFullscreen, onBack]);

  /**
   * 硬件返回键：**先关抽屉 → 再退全屏**，之后才轮到 App 那条（收小窗）。
   *
   * ★ 后注册的监听器先跑（RN 是倒序调用），所以这条会排在 App 那条前面。
   *   两件事都不用的时候不注册，让 App 那条正常生效。
   */
  useEffect(() => {
    if (isTV) {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (drawer !== 'none') {
          setDrawer('none');
          return true;
        }
        // 全屏（详情收起）时，返回先退出全屏，而不是直接收起播放页。
        if (fullscreen) {
          setFullscreen(false);
          return true;
        }
        onBack();
        return true;
      });
      return () => sub.remove();
    }
    if (drawer === 'none' && !fullscreen && !landscape) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drawer !== 'none') {
        setDrawer('none');
        return true;
      }
      exitFullscreen();
      return true;
    });
    return () => sub.remove();
  }, [isTV, drawer, fullscreen, landscape, exitFullscreen, onBack]);

  // ---------- 手势 ----------
  const gesture = useRef({
    mode: 'none' as 'none' | 'seek' | 'volume' | 'brightness' | 'hold',
    startX: 0,
    base: 0,
    moved: false,
    tapAt: 0,
    tapX: 0,
    seekTarget: 0,
  });

  /**
   * 按住快进 / 快退的账本。
   *
   * ★ 老规矩：这类动态值一律走 ref。`pan` 只建一次，值进了依赖数组就会重建，
   *   重建的那一瞬间触摸会掉。
   */
  const hold = useRef({
    dir: 'none' as 'none' | 'fwd' | 'bwd',
    timer: null as ReturnType<typeof setTimeout> | null,
    tick: null as ReturnType<typeof setInterval> | null,
    target: 0,
    wasPaused: false,
  });

  /**
   * 真正进入"按住快进 / 快退"。
   *
   * - **快进**：把播放速率提到 2 倍（渲染时替换 `rate`），画面平滑推进、带声音
   * - **快退**：没有负速率可用，只能暂停 + **定时往回 seek**，净效果同样是 2 倍速
   *
   * ★ 同时把 `mode` 钉成 `hold`：按住之后再滑动手指不该被当成调亮度/音量，
   *   也不要跟"横滑拖进度"打架 —— 要退出就松手。
   */
  const engageHold = useCallback(
    (dir: 'fwd' | 'bwd') => {
      const h = hold.current;
      const g = gesture.current;
      g.moved = true; // ★ 让松手时不再走"单击 / 双击"那条路
      g.mode = 'hold';
      h.dir = dir;
      h.target = positionRef.current;
      h.wasPaused = pausedRef.current;
      setHoldDir(dir);
      bumpChrome();

      if (dir === 'fwd') return;

      setPaused(true);
      h.tick = setInterval(() => {
        const step = (HOLD_RATE * HOLD_REWIND_TICK_MS) / 1000;
        h.target = Math.max(0, h.target - step);
        videoRef.current?.seek(h.target);
        putPosition(h.target);
      }, HOLD_REWIND_TICK_MS);
    },
    [bumpChrome, putPosition],
  );

  /**
   * 收掉"按住快进 / 快退"：清定时器、还原暂停状态。
   *
   * @returns 松手之前是不是正按着快进/快退 —— 是的话就别再当点击处理
   */
  const endHold = useCallback((): boolean => {
    const h = hold.current;
    if (h.timer) {
      clearTimeout(h.timer);
      h.timer = null;
    }
    if (h.tick) {
      clearInterval(h.tick);
      h.tick = null;
    }
    const dir = h.dir;
    h.dir = 'none';
    if (dir === 'none') return false;

    setHoldDir('none');
    if (dir === 'bwd') {
      videoRef.current?.seek(h.target);
      putPosition(h.target);
      // 按住之前是播着的就接着播；本来就是暂停的，继续暂停
      if (!h.wasPaused) setPaused(false);
    }
    return true;
  }, [putPosition]);

  // 卸载时把"按住快进/快退"的定时器收干净 ——
  // 人已经离开这一集了还在 2 倍速播 / 还在往回跳，就成鬼了
  useEffect(
    () => () => {
      const h = hold.current;
      if (h.timer) clearTimeout(h.timer);
      if (h.tick) clearInterval(h.tick);
    },
    [],
  );

  // ★ 依赖里只有尺寸和两个稳定回调 —— 播放过程中不会重建
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: evt => {
          const g = gesture.current;
          const h = hold.current;
          g.mode = 'none';
          g.moved = false;
          g.startX = evt.nativeEvent.locationX;
          g.base = 0;

          // ★ 按住**一动也不动** `HOLD_DELAY_MS` 之后 = 快退 / 快进
          //   （左半屏快退、右半屏快进）。一旦开始拖动，Move 里会把这条撤掉。
          if (h.timer) clearTimeout(h.timer);
          h.timer = setTimeout(() => {
            h.timer = null;
            if (gesture.current.moved) return;
            engageHold(gesture.current.startX < width / 2 ? 'bwd' : 'fwd');
          }, HOLD_DELAY_MS);
        },
        onPanResponderMove: (_evt, state) => {
          const g = gesture.current;
          if (
            !g.moved &&
            (Math.abs(state.dx) > 12 || Math.abs(state.dy) > 12)
          ) {
            g.moved = true;
            // ★ 手指动了就不是"按住"了 —— 撤掉快进/快退的等待
            const h = hold.current;
            if (h.timer) {
              clearTimeout(h.timer);
              h.timer = null;
            }
            if (Math.abs(state.dx) >= Math.abs(state.dy)) {
              g.mode = 'seek';
              g.base = positionRef.current;
            } else if (g.startX < width / 2) {
              g.mode = 'brightness';
              g.base = brightnessRef.current;
            } else {
              g.mode = 'volume';
              g.base = volumeRef.current;
            }
            // 开始拖动就把控制条亮出来，松手后再走自动隐藏
            bumpChrome();
          }
          if (!g.moved) return;
          // 正按着快进/快退：滑动不再改亮度/音量，也不改成拖进度（松手才结束）
          if (g.mode === 'hold') return;

          const travel = height * SWIPE_RANGE;
          if (g.mode === 'seek') {
            const span = Math.max(durationRef.current, 1);
            const delta = (state.dx / Math.max(width, 1)) * span;
            g.seekTarget = Math.max(
              0,
              Math.min(durationRef.current, g.base + delta),
            );
            flashHint(
              `${formatTime(g.seekTarget)} / ${formatTime(
                durationRef.current,
              )}`,
            );
          } else if (g.mode === 'volume') {
            const next = Math.max(0, Math.min(1, g.base - state.dy / travel));
            volumeRef.current = next;
            setVolume(next);
            flashHint(`音量 ${Math.round(next * 100)}%`);
          } else {
            const next = Math.max(0, Math.min(1, g.base - state.dy / travel));
            brightnessRef.current = next;
            applyBrightness(next);
            flashHint(`亮度 ${Math.round(next * 100)}%`);
          }
        },
        onPanResponderRelease: () => {
          // ★ 先收掉"按住快进 / 快退" —— 那一下松手不该再当成单击/双击
          if (endHold()) return;
          const g = gesture.current;
          if (g.moved) {
            if (g.mode === 'seek') {
              videoRef.current?.seek(g.seekTarget);
              putPosition(g.seekTarget);
            }
            g.mode = 'none';
            flashHint(null);
            return;
          }

          // 没移动 = 点击。两次挨得近就是双击快进
          const now = Date.now();
          if (now - g.tapAt < 320 && Math.abs(g.startX - g.tapX) < 90) {
            g.tapAt = 0;
            const back = g.startX < width / 2;
            const span = SKIP_SECONDS * (back ? -1 : 1);
            const target = Math.max(
              0,
              Math.min(durationRef.current, positionRef.current + span),
            );
            videoRef.current?.seek(target);
            putPosition(target);
            flashHint(back ? `« ${SKIP_SECONDS} 秒` : `${SKIP_SECONDS} 秒 »`);
            return;
          }
          g.tapAt = now;
          g.tapX = g.startX;
          toggleChrome();
        },
        onPanResponderTerminate: () => {
          // 被别的响应者抢走（系统手势等）也要收干净，
          // 否则会一直 2 倍速播着 / 一直往回跳
          endHold();
        },
      }),
    [
      width,
      height,
      bumpChrome,
      toggleChrome,
      flashHint,
      putPosition,
      engageHold,
      endHold,
    ],
  );

  // ---------- 进度条拖拽 ----------
  const bar = useRef({ width: 0, dragging: false, target: 0 });

  const seekTo = useCallback(
    (x: number) => {
      const ratio = Math.max(
        0,
        Math.min(1, x / Math.max(bar.current.width, 1)),
      );
      const target = ratio * durationRef.current;
      bar.current.target = target;
      putPosition(target);
    },
    [putPosition],
  );

  const barPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: evt => {
          bar.current.dragging = true;
          bumpChrome();
          seekTo(evt.nativeEvent.locationX);
        },
        onPanResponderMove: evt => seekTo(evt.nativeEvent.locationX),
        onPanResponderRelease: () => {
          bar.current.dragging = false;
          videoRef.current?.seek(bar.current.target);
        },
      }),
    [seekTo, bumpChrome],
  );

  /**
   * 悬浮小窗的拖拽。
   *
   * ★ 位置存在 ref 里、位移交给 `Animated.ValueXY` —— 拖动过程中 `setValue`
   *   直接跟手，松手再用 spring 收一下。全程 **JS 驱动**（`useNativeDriver: false`）：
   *   一个值不能既被 JS 的 setValue 写、又被原生动画驱动，混用 RN 会直接抛错。
   *
   * 拖动距离小于阈值就当成"点击" → 展开回全屏。
   */
  const miniPos = useRef({ x: 0, y: 0 });
  const miniOffset = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [miniSizeIdx, setMiniSizeIdx] = useState(1); // 默认「中」

  /**
   * 上次用小窗时选的档位要**记住**。
   *
   * ★ 小窗是随手收出来的，每次都要重新调一遍大中小太烦；
   *   落 AsyncStorage 所以**重启也还在**。读回来夹一下 ——
   *   历史值可能来自档位更少的旧版本。
   */
  useEffect(() => {
    let alive = true;
    void getMiniSizeIdx().then(saved => {
      if (!alive || saved === null) return;
      setMiniSizeIdx(Math.min(saved, MINI_RATIOS.length - 1));
    });
    return () => {
      alive = false;
    };
  }, []);

  // 三档宽度跟着屏幕走 —— 最大档"比竖屏宽度小一点"
  const miniSizes = useMemo(() => {
    const max = miniMaxWidth(width);
    return MINI_RATIOS.map(s => ({
      label: s.label,
      width: Math.round(max * s.ratio),
    }));
  }, [width]);

  const miniWidth = miniSizes[miniSizeIdx].width;
  const miniHeight = miniHeightOf(miniWidth);

  const cycleMiniSize = useCallback(() => {
    const next = (miniSizeIdx + 1) % MINI_RATIOS.length;
    setMiniSizeIdx(next);
    // 记下来，下次收小窗直接就是这个档位
    void saveMiniSizeIdx(next);
  }, [miniSizeIdx]);

  /**
   * 换档位之后把位置重新夹回屏幕内 ——
   * 窗口变大时原来的偏移可能把它顶出边界。
   */
  useEffect(() => {
    const maxX = Math.max(0, width - miniWidth - MINI_MARGIN * 2);
    const maxY = Math.max(0, height - miniHeight - TAB_BAR_SPACE);
    const next = {
      x: Math.min(0, Math.max(-maxX, miniPos.current.x)),
      y: Math.min(0, Math.max(-maxY, miniPos.current.y)),
    };
    if (next.x === miniPos.current.x && next.y === miniPos.current.y) return;
    miniPos.current = next;
    Animated.spring(miniOffset, {
      toValue: next,
      useNativeDriver: false,
      friction: 7,
    }).start();
  }, [miniWidth, miniHeight, width, height, miniOffset]);

  const miniPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_evt, g) => {
          miniOffset.setValue({
            x: miniPos.current.x + g.dx,
            y: miniPos.current.y + g.dy,
          });
        },
        onPanResponderRelease: (_evt, g) => {
          if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
            // ★ 轻点小窗 = **显隐那几个按钮**（跟系统画中画一样），
            //   不直接展开 —— 展开交给「展开」按钮本身。
            //   小窗本来就小，按钮常驻太挡画面。
            toggleChrome();
            return;
          }
          // 往左上拖是负方向；夹住别拖出屏幕
          const maxX = Math.max(0, width - miniWidth - MINI_MARGIN * 2);
          const maxY = Math.max(0, height - miniHeight - TAB_BAR_SPACE);
          miniPos.current = {
            x: Math.min(0, Math.max(-maxX, miniPos.current.x + g.dx)),
            y: Math.min(0, Math.max(-maxY, miniPos.current.y + g.dy)),
          };
          Animated.spring(miniOffset, {
            toValue: miniPos.current,
            useNativeDriver: false,
            friction: 7,
          }).start();
        },
      }),
    [width, height, miniOffset, miniWidth, miniHeight, toggleChrome],
  );

  /**
   * 一段 / 一集播完之后接什么。
   *
   * 优先级：
   *   1. 源2 还有下一段 mp4 → **接下一段**（一集可能被切成十几段）
   *   2. 不是最后一集 → **接下一集**（自动连播）
   *   3. 都到头了 → 暂停
   *
   * ★ 画中画 / 小窗里走的是同一条链路 —— 那边也照样会 `onEnd`，
   *   所以连播在画中画里同样成立。
   */
  const handlePlaybackEnd = useCallback(() => {
    if (detail.sourceId === 's2' && segIdx + 1 < s2Segments.length) {
      setSegIdx(segIdx + 1);
      return;
    }

    const next = detail.episodes[epIdx + 1];
    if (next) {
      flashHint(`即将播放 ${next.title}`);
      setEpIdx(epIdx + 1);
      setPickIdx(0); // 换集把线路选择也复位；segIdx 由解析 effect 归零
      return;
    }

    setPaused(true);
  }, [detail, epIdx, segIdx, s2Segments.length, flashHint]);

  const toggleFullscreen = useCallback(() => {
    // TV：横屏是常态，「全屏」只表示把右侧的剧集详情收起来、画面铺满。
    // 不请求转屏 —— TV 上转屏没有意义，而且会让整个界面横着显示。
    if (isTV) {
      flashHint(fullscreen ? '已退出全屏' : '已进入全屏');
      setFullscreen(!fullscreen);
      return;
    }
    // 已经在横屏（不管是不是自己切的）→ 这一步就是"退出全屏"
    if (fullscreen || landscape) {
      exitFullscreen();
      return;
    }
    setFullscreen(true);
    setOrientation('landscape');
    // 给个可见反馈 —— 转屏是系统行为，失败时按钮看着像"没反应"
    flashHint('正在切横屏…');
  }, [isTV, fullscreen, landscape, exitFullscreen, flashHint, setOrientation]);

  const lineLabel = stream ? stream.lineName : '正在解析线路…';
  // 源1 是线路表；源2 是清晰度档位（别跟分段混了）
  const lineCount =
    detail.sourceId === 's1' ? s1Lines.length : detail.qualities?.length ?? 0;
  // 源2 直接显示**实际拿到的清晰度**（上游可能静默降级，光看请求的档位会误判）；
  // 源1 显示线路条数
  const pickerLabel =
    detail.sourceId === 's2'
      ? lineLabel
      : lineCount > 1
      ? `线路 ${lineCount}`
      : lineLabel;
  // 多段 mp4 时给个进度提示
  const segmentLabel =
    s2Segments.length > 1 ? `第 ${segIdx + 1}/${s2Segments.length} 段` : '';
  const progressRatio =
    duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

  /**
   * ★ 季切换条（源2 多季的剧）。
   *
   * 上游把每一季当**独立的剧**（独立 sid）：「顶楼3」的 buckets 是
   * 第一季 / 第二季 / 第三季，各自 21 / 13 / 14 集；「换乘恋爱2」有 5 项。
   * 以前这个列表没往上传，点进去只显示当前那一季，看着像"少了"。
   *
   * 当前季用 `detail.vodId` 对（它就是这一季的 sid）—— 注意**不是**最后一项，
   * 上游给的顺序不按季号（「换乘恋爱」的第四季排在衍生篇后面）。
   */
  const seasons = detail.seasons ?? [];
  const hasSeasons = seasons.length > 1;
  const seasonButtons = seasons.map(s => {
    const active = s.sid === detail.vodId;
    return (
      <Pressable
        key={s.sid}
        style={[styles.cell, active && styles.cellActive]}
        disabled={active}
        onPress={() => onSelectSeason?.(s.sid)}
      >
        <Text
          style={[styles.cellText, active && styles.cellTextActive]}
          numberOfLines={1}
        >
          {s.title || '正片'}
        </Text>
      </Pressable>
    );
  });

  return (
    <View
      style={[
        styles.root,
        mini && styles.rootMini,
        isTV && !mini && !fullscreen && styles.rootTv,
      ]}
      pointerEvents={mini ? 'box-none' : 'auto'}
    >
      {/*
        竖屏贴顶 16:9、横屏铺满；小窗模式缩到角落。
        ★ 全屏和小窗是**同一个容器**的两种样式，不是两个分支 ——
          `<Video>` 一旦换位置就会重新挂载，播放会从头开始。
      */}
      <Animated.View
        style={[
          styles.stage,
          landscape
            ? styles.stageFull
            : { height: Math.round((width * 9) / 16), marginTop: insets.top },
          isTV && !mini && !fullscreen && styles.stageTv,
          mini && styles.miniBox,
          mini && { width: miniWidth, height: miniHeight },
          mini && { transform: miniOffset.getTranslateTransform() },
        ]}
      >
        {/*
          ★ 投屏中就把本地这一路停掉、换成一张状态卡：
            同一个片子手机和电视一起放没有意义，而且转发模式下
            两路一起取流只会互相抢带宽。
        */}
        {castActive ? (
          <View style={styles.castStage}>
            <Text style={styles.castStageTitle} numberOfLines={2}>
              正在投屏到 {castActive.device.name}
            </Text>
            <Text style={styles.castStageHint}>
              {castActive.direct
                ? '直投 · 手机可以息屏、可以退出 App'
                : castActive.keepAlive
                  ? '经手机转发 · 已开启后台保活，可以息屏（别强行退出 App）'
                  : '经手机转发 · 投屏期间请别息屏或退出 App'}
            </Text>
            <Pressable style={styles.castStageBtn} onPress={openCast}>
              <Text style={styles.castStageBtnText}>投屏控制</Text>
            </Pressable>
          </View>
        ) : stream ? (
          <Video
            ref={videoRef}
            source={{ uri: stream.streamUrl, headers: stream.headers }}
            style={styles.video}
            resizeMode="contain"
            paused={paused}
            /** ★ 按住右半屏快进 = 临时把速率提到 2 倍（松手回落） */
            rate={holdDir === 'fwd' ? HOLD_RATE : rate}
            volume={volume}
            progressUpdateInterval={500}
            // ★★ 不加这两行，一退到后台播放就停。
            //   RNV 的 Android onHostPause 里写着：
            //     if (playInBackground || isInPictureInPicture || isInMultiWindowMode) return;
            //     setPlayWhenReady(false);
            //   playInBackground 默认 false，所以默认行为就是"退后台即暂停"。
            //   （进画中画时 isInPictureInPicture 为真，本来就能继续，但普通后台不行。）
            playInBackground
            playWhenInactive
            onLoad={data => {
              putDuration(data.duration ?? 0);
              // ★ 拿视频真实宽高比去对齐画中画窗口，不然画中画两侧留白
              const size = data.naturalSize;
              if (size) setPipAspectRatio(size.width, size.height);
            }}
            onProgress={data => {
              if (!bar.current.dragging) putPosition(data.currentTime ?? 0);
            }}
            onBuffer={e => setBuffering(Boolean(e.isBuffering))}
            // ★ 系统画中画：用户上滑回桌面时自动浮起来（Android 12+ 用
            //   setAutoEnterEnabled，8~11 走 onHostPause）。
            //   应用内小窗（mini）时不启用 —— 那个已经缩在角落了。
            enterPictureInPictureOnLeave={!mini}
            onPictureInPictureStatusChanged={e => {
              const active = Boolean(e?.isActive);
              setInPip(active);
              // 进画中画就把控制条收掉，否则会一起出现在那个小窗里
              if (active) {
                chromeRef.current = false;
                setChrome(false);
              } else {
                // ★ 退出画中画。两种走法要区分：
                //   - 点「回到 App」→ App 会 resume、AppState 变 active → 继续播
                //   - 点 ✕ 关掉 → App 仍在后台 → 把视频停掉
                //   playInBackground=true 是为了"后台继续播"，但用户明确要 ✕ 停掉，
                //   所以这里补一刀。延迟一拍是让 AppState 先稳定下来，避开顺序问题。
                setTimeout(() => {
                  if (AppState.currentState !== 'active') setPaused(true);
                }, 300);
                bumpChrome();
              }
            }}
            onRestoreUserInterfaceForPictureInPictureStop={() => {
              // 用户点了画中画窗上的「回到 App」—— 展开回全屏
              onExpand();
              videoRef.current?.restoreUserInterfaceForPictureInPictureStopCompleted(
                true,
              );
            }}
            onEnd={handlePlaybackEnd}
            onError={e =>
              setError(`播放失败：${e?.error?.errorString ?? '未知错误'}`)
            }
          />
        ) : (
          <View style={styles.center}>
            {loading ? <ActivityIndicator color={color.accent} /> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        )}

        {/*
          ★★ 手势层必须是盖在视频**上面**的独立一层。
          不要把 panHandlers 挂在 stage 上指望冒泡上来 —— 播放器的原生视图
          （Android 是 FrameLayout、iOS 是 AVPlayerLayer）会把触摸吃掉，
          挂在父级上收不到，表现就是"点屏幕没反应、控制条再也出不来"。
          注意顺序：它必须排在 <Video> **之后**（盖住视频），
          又要排在控制条 **之前**（控制条的按钮才点得到）。
        */}
        {/*
          ★★ 手势层盖在视频**上面**，全屏和小窗共用这一层 ——
          挂到 <Video> 的父级上是收不到触摸的（播放器的原生视图会吃掉），
          这条坑全屏模式已经踩过一次，小窗当时漏了：结果小窗点不动、
          只能按 ✕ 关掉。
        */}
        <View
          style={styles.gestureLayer}
          {...(mini ? miniPan.panHandlers : pan.panHandlers)}
        />

        {buffering && stream ? (
          <View style={styles.buffering} pointerEvents="none">
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}

        {/*
          按住快进 / 快退的提示**常驻到松手** —— 不能用 `flashHint`
          （它 900ms 就自动撤），按住好几秒的人会中途看不到任何反馈。
        */}
        {holdDir !== 'none' || hint ? (
          <View style={styles.hintBox} pointerEvents="none">
            <Text style={styles.hintText}>
              {holdDir === 'fwd'
                ? `${HOLD_RATE}x 快进 ▶▶`
                : holdDir === 'bwd'
                ? `${HOLD_RATE}x 快退 ◀◀ ${formatTime(position)}`
                : hint}
            </Text>
          </View>
        ) : null}

        {mini ? (
          <>
            {/* TV：整块小窗可聚焦。回到主页后遥控器能选中它，按确定展开 ——
                否则小窗只是一块不可聚焦的 View，用户回不去播放页。 */}
            {isTV ? (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={onExpand}
                hasTVPreferredFocus={miniFocusPending}
                onFocus={() => setMiniFocusPending(false)}
                accessibilityLabel="展开播放页"
              />
            ) : null}
            {paused ? (
              <View style={styles.miniPaused} pointerEvents="none">
                <Text style={styles.miniPausedText}>▶</Text>
              </View>
            ) : null}
            {/*
              三个按钮跟控制条一样**点一下才出来**（跟系统画中画一致）——
              小窗本来就小，常驻太挡画面。
            */}
            {chrome ? (
              <>
                <Pressable
                  onPress={onExpand}
                  style={styles.miniExpand}
                  hitSlop={8}
                >
                  <Text style={styles.miniExpandText}>展开</Text>
                </Pressable>
                <Pressable
                  onPress={cycleMiniSize}
                  style={styles.miniSize}
                  hitSlop={8}
                >
                  <Text style={styles.miniSizeText}>
                    {miniSizes[miniSizeIdx].label}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={onClose}
                  style={styles.miniClose}
                  hitSlop={10}
                >
                  <Text style={styles.miniCloseText}>✕</Text>
                </Pressable>
              </>
            ) : null}
          </>
        ) : chrome ? (
          <>
            <View style={[styles.topBar, { paddingTop: space.sm + topPad }]}>
              <Pressable
                onPress={handleBack}
                style={styles.iconBtn}
                hitSlop={8}
                hasTVPreferredFocus={playerFocusPending}
                onFocus={() => setPlayerFocusPending(false)}
              >
                <Text style={styles.iconText}>‹</Text>
              </Pressable>
              <Text style={styles.title} numberOfLines={1}>
                {detail.name} · {episode?.title ?? ''}
              </Text>
              {/* 投屏入口（文档 §5.5.5：播放器右上角常驻） */}
              <Pressable onPress={openCast} style={styles.iconBtn} hitSlop={8}>
                <Text
                  style={[styles.castText, castActive && styles.castTextActive]}
                >
                  {castActive ? '投屏中' : '投屏'}
                </Text>
              </Pressable>
            </View>

            <View
              style={[
                styles.bottomBar,
                { paddingBottom: space.sm + bottomPad },
              ]}
            >
              <View
                style={styles.barTrack}
                onLayout={e => {
                  bar.current.width = e.nativeEvent.layout.width;
                }}
                {...barPan.panHandlers}
              >
                <View style={styles.barBackground} />
                <View
                  style={[styles.barFill, { width: `${progressRatio}%` }]}
                />
                <View style={[styles.barKnob, { left: `${progressRatio}%` }]} />
              </View>

              <View style={styles.controls}>
                <Pressable
                  onPress={() => setPaused(p => !p)}
                  style={styles.iconBtn}
                  hitSlop={8}
                >
                  <Text style={styles.controlText}>{paused ? '▶' : '❚❚'}</Text>
                </Pressable>
                <Text style={styles.time}>
                  {formatTime(position)} / {formatTime(duration)}
                </Text>

                <View style={styles.spacer} />

                <Pressable
                  onPress={() => setDrawer('speed')}
                  style={styles.chipBtn}
                  hitSlop={6}
                >
                  <Text style={styles.chipText}>{rate}x</Text>
                </Pressable>
                <Pressable
                  onPress={() => setDrawer('line')}
                  style={styles.chipBtn}
                  hitSlop={6}
                >
                  <Text style={styles.chipText}>{pickerLabel}</Text>
                </Pressable>
                {/* 竖屏下选集网格就在视频下方，不用再开抽屉 */}
                {landscape ? (
                  <Pressable
                    onPress={() => setDrawer('episode')}
                    style={styles.chipBtn}
                    hitSlop={6}
                  >
                    <Text style={styles.chipText}>选集</Text>
                  </Pressable>
                ) : null}
                {/* 画中画是手机上的能力；TV 上给「全屏」—— 视频与剧集详情
                    分屏时，把详情收起来让画面铺满。 */}
                {!isTV ? (
                  <>
                    <Pressable
                      onPress={() => videoRef.current?.enterPictureInPicture()}
                      style={styles.chipBtn}
                      hitSlop={6}
                    >
                      <Text style={styles.chipText}>
                        {inPip ? '画中画中' : '画中画'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={toggleFullscreen}
                      style={styles.chipBtn}
                      hitSlop={6}
                    >
                      <Text style={styles.chipText}>
                        {fullscreen || landscape ? '退出全屏' : '全屏'}
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={toggleFullscreen}
                    style={styles.chipBtn}
                    hitSlop={6}
                  >
                    <Text style={styles.chipText}>
                      {fullscreen ? '退出全屏' : '全屏'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          </>
        ) : null}
      </Animated.View>

      {/* 竖屏：视频下面接剧集详情与选集（B 站那种），把空间用起来。
          TV 上详情在右侧（见 rootTv）；按「全屏」后把它收起来，画面铺满。 */}
      {!mini && (!landscape || isTV) && !(isTV && fullscreen) ? (
        <ScrollView
          style={[styles.panel, isTV && styles.panelTv]}
          contentContainerStyle={[
            styles.panelContent,
            { paddingBottom: space.xl + insets.bottom },
          ]}
        >
          <View style={styles.infoRow}>
            <Image
              source={{ uri: detail.pic }}
              style={styles.poster}
              resizeMode="cover"
            />
            <View style={styles.infoMeta}>
              <Text style={styles.infoTitle} numberOfLines={2}>
                {detail.name}
              </Text>
              <Text style={styles.infoSub} numberOfLines={1}>
                {[
                  detail.year,
                  detail.area,
                  detail.director ? `导演：${detail.director}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {detail.actor ? (
                <Text style={styles.infoSub} numberOfLines={3}>
                  主演：{detail.actor}
                </Text>
              ) : null}
              <Text style={styles.infoBadge}>
                {detail.sourceId === 's1' ? '全网源' : '精选源'}
              </Text>
            </View>
          </View>

          {detail.blurb ? (
            <Text style={styles.blurb}>{detail.blurb}</Text>
          ) : null}

          {/* 多季的剧：先选季，再选集（每一季的选集是另一套） */}
          {hasSeasons ? (
            <>
              <Text style={styles.sectionTitle}>季</Text>
              <View style={styles.seasonRow}>{seasonButtons}</View>
            </>
          ) : null}

          <Text style={styles.sectionTitle}>
            选集（{detail.episodes.length}）
            {segmentLabel ? `　·　${segmentLabel}` : ''}
          </Text>
          <View style={styles.episodeGrid}>
            {detail.episodes.map(ep => (
              <Pressable
                key={`${ep.episodeIndex}-${ep.title}`}
                style={[
                  styles.cell,
                  ep.episodeIndex === epIdx && styles.cellActive,
                ]}
                onPress={() => {
                  setEpIdx(ep.episodeIndex);
                  setPickIdx(0);
                }}
              >
                <Text
                  style={[
                    styles.cellText,
                    ep.episodeIndex === epIdx && styles.cellTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {/* ★ 正在播放的那一集加个记号，不然一屏格子看不出播到哪儿了 */}
                  {ep.episodeIndex === epIdx ? '▶ ' : ''}
                  {ep.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}

      {/* 小窗时压根不渲染抽屉 —— 见上面 mini 那个 effect 的注释 */}
      {!mini && drawer !== 'none' ? (
        <View style={styles.drawer}>
          <View style={styles.drawerHead}>
            <Text style={styles.drawerTitle}>
              {drawer === 'episode'
                ? `选集（${detail.episodes.length}）`
                : drawer === 'line'
                ? detail.sourceId === 's1'
                  ? '线路'
                  : '清晰度'
                : '倍速'}
            </Text>
            <Pressable onPress={() => setDrawer('none')} hitSlop={8}>
              <Text style={styles.drawerClose}>收起</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.drawerBody}>
            {/* 横屏走抽屉：多季的剧先给一行季切换，再列这一季的选集 */}
            {drawer === 'episode' && hasSeasons ? (
              <View style={styles.seasonRow}>{seasonButtons}</View>
            ) : null}

            {drawer === 'episode'
              ? detail.episodes.map(ep => (
                  <Pressable
                    key={`${ep.episodeIndex}-${ep.title}`}
                    style={[
                      styles.cell,
                      ep.episodeIndex === epIdx && styles.cellActive,
                    ]}
                    hasTVPreferredFocus={
                      episodeFocusPending && ep.episodeIndex === epIdx
                    }
                    onFocus={() => setEpisodeFocusPending(false)}
                    onPress={() => {
                      setEpIdx(ep.episodeIndex);
                      setPickIdx(0);
                      setDrawer('none');
                    }}
                  >
                    <Text
                      style={[
                        styles.cellText,
                        ep.episodeIndex === epIdx && styles.cellTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {/* ★ 正在播放的那一集加个记号，不然一屏格子看不出播到哪儿了 */}
                      {ep.episodeIndex === epIdx ? '▶ ' : ''}
                      {ep.title}
                    </Text>
                  </Pressable>
                ))
              : null}

            {drawer === 'line'
              ? detail.sourceId === 's1'
                ? s1Lines.map((line, index) => (
                    <Pressable
                      key={`${line.kind}-${line.name}-${index}`}
                      style={[
                        styles.cell,
                        index === pickIdx && styles.cellActive,
                      ]}
                      onPress={() => {
                        setPickIdx(index);
                        setDrawer('none');
                      }}
                    >
                      <Text
                        style={[
                          styles.cellText,
                          index === pickIdx && styles.cellTextActive,
                        ]}
                      >
                        {line.name}
                      </Text>
                    </Pressable>
                  ))
                : // ★ 源2 这里是**清晰度**，不是分段 —— 选完带 sq 重新解析
                  (detail.qualities ?? []).map(quality => (
                    <Pressable
                      key={`q-${quality.value}`}
                      style={[
                        styles.cell,
                        quality.value === s2Quality && styles.cellActive,
                      ]}
                      onPress={() => {
                        setS2Quality(quality.value);
                        setDrawer('none');
                      }}
                    >
                      <Text
                        style={[
                          styles.cellText,
                          quality.value === s2Quality && styles.cellTextActive,
                        ]}
                      >
                        {quality.label}
                      </Text>
                    </Pressable>
                  ))
              : null}

            {drawer === 'speed'
              ? SPEEDS.map(value => (
                  <Pressable
                    key={value}
                    style={[styles.cell, value === rate && styles.cellActive]}
                    onPress={() => {
                      setRate(value);
                      setDrawer('none');
                    }}
                  >
                    <Text
                      style={[
                        styles.cellText,
                        value === rate && styles.cellTextActive,
                      ]}
                    >
                      {value}x
                    </Text>
                  </Pressable>
                ))
              : null}
          </ScrollView>
        </View>
      ) : null}

      {/* 投屏设备抽屉。★ 小窗模式下不弹 —— 小窗时用户在看别处 */}
      {!mini ? (
        <CastSheet
          visible={castOpen}
          devices={castDevices}
          scanning={castScanning}
          error={castError}
          active={castActive}
          connectingId={castConnectingId}
          transport={castTransport}
          onClose={() => setCastOpen(false)}
          onRefresh={() => void scanCastDevices()}
          onPick={device => void startCast(device)}
          onStop={() => void stopCast()}
          onTogglePlay={() => void toggleCastPlay()}
        />
      ) : null}
    </View>
  );
}

/** 详情还没回来时的占位外壳 */
const shell = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  text: { color: '#fff', fontSize: 15, marginBottom: 12 },
  error: {
    color: '#FF6B6B',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  btn: { marginTop: 20, paddingHorizontal: 20, paddingVertical: 8 },
  btnText: { color: '#FFB454', fontSize: 15 },
});

const makeStyles = (color: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    // 小窗模式下整页透明，只留那块小窗；touch 透给底下的 Tab
    rootMini: { backgroundColor: 'transparent' },
    miniBox: {
      position: 'absolute',
      right: MINI_MARGIN,
      bottom: TAB_BAR_SPACE,
      // 宽高由档位决定，见 MINI_SIZES
      marginTop: 0,
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: '#000',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.25)',
      elevation: 12,
      shadowColor: '#000',
      shadowOpacity: 0.45,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    miniPaused: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.35)',
    },
    miniPausedText: { color: '#fff', fontSize: 22 },
    miniExpand: {
      position: 'absolute',
      top: 4,
      left: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 8,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    miniExpandText: { color: '#fff', fontSize: 10 },
    miniSize: {
      position: 'absolute',
      right: 4,
      bottom: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 8,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    miniSizeText: { color: '#fff', fontSize: 10 },
    miniClose: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    miniCloseText: { color: '#fff', fontSize: 12, lineHeight: 14 },
    // ★ TV：视频在左、详情/选集在右，不再靠"转竖屏"去看详情
    rootTv: { flexDirection: 'row' },
    // ★ TV：视频在左、详情/选集在右，比例 **3:1**（视频占 3/4）。
    //   原先面板写的是 38%，视频只剩六成（用户 2026-10-22 反馈「播放占得太少、
    //   列表占得太宽」）。用 flex 3:1 而不是百分比：换任何分辨率的电视，
    //   比例都不变。
    stageTv: { width: 'auto', flex: 3 },
    stage: { width: '100%', backgroundColor: '#000', justifyContent: 'center' },
    stageFull: { flex: 1 },
    video: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    gestureLayer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    center: { alignItems: 'center', padding: space.xl },
    error: {
      color: color.danger,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
      paddingHorizontal: space.xl,
    },
    buffering: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hintBox: {
      position: 'absolute',
      alignSelf: 'center',
      top: '38%',
      backgroundColor: 'rgba(0,0,0,0.66)',
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: radius.md,
    },
    hintText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.md,
      // 上下分开写 —— 顶层要跟 paddingVertical 同时给的话优先级有歧义
      paddingTop: space.sm,
      paddingBottom: space.sm,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    title: { color: '#fff', fontSize: 14, marginLeft: space.sm, flex: 1 },
    castText: { color: '#fff', fontSize: 13 },
    castTextActive: { color: color.accent, fontWeight: '700' },
    castStage: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: space.xl,
    },
    castStageTitle: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
    castStageHint: {
      color: 'rgba(255,255,255,0.72)',
      fontSize: 12,
      marginTop: space.sm,
      textAlign: 'center',
      lineHeight: 18,
    },
    castStageBtn: {
      marginTop: space.lg,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(255,255,255,0.14)',
    },
    castStageBtnText: { color: '#fff', fontSize: 14 },
    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: space.md,
      paddingTop: space.sm,
      paddingBottom: space.sm,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    barTrack: { height: 24, justifyContent: 'center' },
    barBackground: {
      height: 3,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.28)',
    },
    barFill: {
      position: 'absolute',
      left: 0,
      height: 3,
      borderRadius: 2,
      backgroundColor: color.accent,
    },
    barKnob: {
      position: 'absolute',
      width: 12,
      height: 12,
      borderRadius: 6,
      marginLeft: -6,
      backgroundColor: color.accent,
    },
    controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    iconBtn: { paddingHorizontal: space.sm, paddingVertical: space.xs },
    iconText: { color: '#fff', fontSize: 26, lineHeight: 30 },
    controlText: { color: '#fff', fontSize: 16 },
    time: { color: '#fff', fontSize: 12, opacity: 0.85 },
    spacer: { flex: 1 },
    chipBtn: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(255,255,255,0.14)',
    },
    chipText: { color: '#fff', fontSize: 12 },
    // 竖屏视频下方那块：剧集详情 + 选集
    panel: { flex: 1, backgroundColor: color.bg },
    // 与 stageTv 的 flex 3 配对：视频 3 份、面板 1 份。
    panelTv: { flex: 1 },
    panelContent: { padding: space.lg, paddingBottom: space.xl * 2 },
    infoRow: { flexDirection: 'row', gap: space.lg },
    poster: {
      width: 92,
      height: 129,
      borderRadius: radius.md,
      backgroundColor: color.surface,
    },
    infoMeta: { flex: 1 },
    infoTitle: {
      color: color.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 22,
    },
    infoSub: {
      color: color.textDim,
      fontSize: 12,
      marginTop: space.xs,
      lineHeight: 17,
    },
    infoBadge: {
      alignSelf: 'flex-start',
      marginTop: space.sm,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceStrong,
      color: color.text,
      fontSize: 10,
      overflow: 'hidden',
    },
    blurb: {
      color: color.textDim,
      fontSize: 13,
      lineHeight: 20,
      marginTop: space.lg,
    },
    sectionTitle: {
      color: color.text,
      fontSize: 15,
      fontWeight: '600',
      marginTop: space.xl,
      marginBottom: space.md,
    },
    episodeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    // 季切换条：竖屏面板里跟在「季」标题下面，横屏抽屉里是整行 ——
    // width 100% 是给抽屉那处用的（drawerBody 是 wrap 行容器，
    // 不加宽度的话这一条会被当成单个 flex item 撑出屏幕）
    seasonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.sm,
      width: '100%',
    },
    drawer: {
      maxHeight: '45%',
      backgroundColor: color.bg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    drawerHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    drawerTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
    drawerClose: { color: color.accent, fontSize: 13 },
    drawerBody: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingTop: space.sm,
      paddingBottom: space.xl,
    },
    cell: {
      minWidth: 78,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.sm,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      alignItems: 'center',
    },
    // 正在播放的那一集：描边加粗 + 底纹更亮，配上标题里的 ▶
    cellActive: {
      borderColor: color.accent,
      borderWidth: 1.5,
      backgroundColor: color.surfaceStrong,
    },
    cellText: { color: color.text, fontSize: 12 },
    cellTextActive: { color: color.accent, fontWeight: '600' },
  });
