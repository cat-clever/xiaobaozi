/**
 * 投屏设备抽屉（液态玻璃底部弹层）。
 *
 * 交互见文档 §5.5.5：设备列表实时刷新、空列表给引导、投屏中显示"正在投屏到 X"
 * 并给一个遥控器。
 *
 * ★ 直投 / 转发**必须在界面上说清楚**（文档 §5.5.4 的"已知限制"）：
 *   转发模式流经手机，进程一停投屏就断 —— 不提示的话用户会以为是 App 坏了。
 *   现在转发投屏会起前台服务保活（`RelayKeepAliveService`），所以能息屏；
 *   但**保活没起来**（老原生包 / 系统拒绝）时必须退回"别息屏"的提示。
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Pressable } from './FocusablePressable';

import { AirPlayButton, AIRPLAY_AVAILABLE } from './AirPlayButton';
import { GlassBox } from './GlassBox';
import { radius, space, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { CastDevice, CastTransportState } from '../cast/types';

/** 正在投的那一台 */
export interface ActiveCast {
  device: CastDevice;
  direct: boolean;
  /**
   * 转发模式下**保活有没有真的开起来**（Android 前台服务 + 唤醒锁）。
   *
   * ★ 直投恒为 false（不需要）。保活没起来时界面必须提醒用户别息屏 ——
   *   不能因为"我们调过"就假装开着了。
   */
  keepAlive: boolean;
  lineName: string;
  /**
   * **实际投给电视的那个地址**。
   *
   * ★ 只用来诊断：转发模式下电视取流失败时，界面之外看不到任何东西
   *   （取流是电视的**出站**请求，电视那侧的日志里不会有记录）。
   *   把它摆出来，用户能拿电脑浏览器打开验证"手机的服务到底通不通" ——
   *   通就是电视的问题，不通就是地址/服务的问题（2026-10-16 排查用）。
   */
  url: string;
}

interface Props {
  visible: boolean;
  devices: CastDevice[];
  scanning: boolean;
  error: string | null;
  active: ActiveCast | null;
  /** 正在连的那一台（点了但还没投上） */
  connectingId: string | null;
  transport: CastTransportState | null;
  onClose: () => void;
  onRefresh: () => void;
  onPick: (device: CastDevice) => void;
  onStop: () => void;
  onTogglePlay: () => void;
}

export function CastSheet({
  visible,
  devices,
  scanning,
  error,
  active,
  connectingId,
  transport,
  onClose,
  onRefresh,
  onPick,
  onStop,
  onTogglePlay,
}: Props): React.JSX.Element | null {
  const { color } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);
  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* 点空白处收起 */}
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        {/*
          ★ 这里**关掉玻璃**（2026-10-20）。Android 的 GlassView 会把
            "背后的窗口内容"抓下来再画一遍 —— 而抓取时 scrim 还在，
            于是抽屉采到的是**被压暗的页面**：背后是浅色详情页时整块抽屉
            发灰（用户截图反馈"抽屉变暗了"）。`sheet` 里本来就垫了
            `barSolid` 实底，关掉玻璃正好把它露出来，颜色与背后无关。
        */}
        <GlassBox style={styles.sheet} cornerRadius={radius.lg} enabled={false}>
          <View style={styles.header}>
            <Text style={styles.title}>投屏</Text>
            <Pressable onPress={onRefresh} hitSlop={10} disabled={scanning}>
              <Text style={[styles.refresh, scanning && styles.refreshBusy]}>
                {scanning ? '搜索中…' : '刷新'}
              </Text>
            </Pressable>
          </View>

          {/*
            ★ 整个正文（投屏中面板 + 设备列表）放进**同一个 ScrollView**。
              原来只给设备列表套 ScrollView，投屏中面板（诊断信息很长）
              一撑，`sheet` 的 maxHeight 70% 直接把列表裁掉 —— 投屏时
              根本看不到/选不了别的设备（2026-10-20 用户反馈）。
          */}
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {active ? (
              <CastingPanel
                active={active}
                transport={transport}
                styles={styles}
                onTogglePlay={onTogglePlay}
                onStop={onStop}
              />
            ) : null}

            {/* AirPlay 是系统控件，只能把系统那枚按钮摆出来 */}
            {AIRPLAY_AVAILABLE && !active ? (
              <View style={styles.airplayRow}>
                <View style={styles.deviceText}>
                  <Text style={styles.deviceName}>AirPlay</Text>
                  <Text style={styles.deviceMeta}>Apple TV、支持隔空播放的电视</Text>
                </View>
                <AirPlayButton style={styles.airplayButton} />
              </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            {devices.map(device => {
              const busy = connectingId === device.id;
              return (
                <Pressable
                  key={device.id}
                  style={styles.deviceRow}
                  disabled={!!connectingId}
                  onPress={() => onPick(device)}
                >
                  <View style={styles.deviceText}>
                    <Text style={styles.deviceName} numberOfLines={1}>
                      {device.name}
                    </Text>
                    <Text style={styles.deviceMeta} numberOfLines={1}>
                      {device.model ? `${device.model} · ` : ''}
                      {device.address ?? ''}
                    </Text>
                  </View>
                  {busy ? (
                    <ActivityIndicator color={color.accent} size="small" />
                  ) : (
                    <Text style={styles.castAction}>投屏</Text>
                  )}
                </Pressable>
              );
            })}

            {!devices.length && !scanning ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>没发现设备</Text>
                <Text style={styles.emptyHint}>
                  请确认手机和电视连的是同一个 Wi-Fi{'\n'}
                  电视上的「投屏 / 多屏互动 / Miracast」开关要打开
                </Text>
                {/*
                  ★ iOS 14+ 发现设备要「本地网络」权限；侧载包第一次
                    搜索时会弹窗，拒绝过就再也不弹了 —— 必须告诉用户去哪开。
                */}
                {Platform.OS === 'ios' ? (
                  <Text style={styles.emptyHint}>
                    iPhone 还要允许「本地网络」：{'\n'}
                    设置 → 小包子影视 → 本地网络
                  </Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </GlassBox>
      </View>
    </View>
  );
}

/** 投屏中：说清楚投到哪、能不能息屏、给个遥控器 */
function CastingPanel({
  active,
  transport,
  styles,
  onTogglePlay,
  onStop,
}: {
  active: ActiveCast;
  transport: CastTransportState | null;
  styles: ReturnType<typeof makeStyles>;
  onTogglePlay: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const playing = transport?.state === 'playing';
  return (
    <View style={styles.casting}>
      <Text style={styles.castingTitle} numberOfLines={1}>
        正在投屏到 {active.device.name}
      </Text>
      <Text style={styles.castingMeta}>
        {active.lineName} · {active.direct ? '直投' : '经手机转发'}
      </Text>
      {/* ★ 转发模式必须把这条讲出来（文档 §5.5.4）—— 保活开没开决定说哪句 */}
      {!active.direct ? (
        <Text style={styles.warn}>
          {active.keepAlive
            ? '转发模式：已开启后台保活，可以息屏；请别强行退出 App'
            : '转发模式：投屏期间请别让手机息屏或退出 App'}
        </Text>
      ) : null}
      {/*
        ★ 转发模式下把投过去的地址摆出来（诊断用）。
          电视"收下了但不出画面"时，这是唯一能分清责任的办法：
          拿电脑浏览器打开这个地址 —— 能下到播放列表说明手机服务可达，
          问题在电视；打不开说明地址或服务不对。长按可选中复制。
      */}
      {!active.direct ? (
        <Text style={styles.castUrl} selectable numberOfLines={4}>
          {active.url}
        </Text>
      ) : null}
      <View style={styles.castingActions}>
        <Pressable style={styles.action} onPress={onTogglePlay}>
          <Text style={styles.actionText}>{playing ? '暂停' : '播放'}</Text>
        </Pressable>
        <Pressable style={[styles.action, styles.actionDanger]} onPress={onStop}>
          <Text style={[styles.actionText, styles.actionTextDanger]}>停止投屏</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (color: Palette) =>
  StyleSheet.create({
    // ★ 这里手写四条边：这个 RN 版本的类型里没有 `absoluteFillObject`
    // ★ 遮罩压到 0.32：原来 0.45 把正在播的画面整个压灰，
    //   用户第一眼看到的是"画面变灰了"而不是"弹了个面板"（2026-10-16 反馈）。
    //   面板自己带了实底与阴影（见下），不靠遮罩来拉开层次。
    scrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.32)',
    },
    sheetWrap: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space.xl + space.lg,
      maxHeight: '70%',
      overflow: 'hidden',
      /**
       * ★★ 面板**必须自己带底**，不能只靠 `GlassBox`。
       *
       *   玻璃层在 Android 上是"把背后的内容抓下来糊一遍再画回来"
       *   （见 `GlassView.kt`）：它抓到的是**被遮罩压暗后的播放页**，
       *   糊完再画上去跟周围几乎同色；抓取失败走兜底时更糟 ——
       *   兜底只画一层很淡的白渐变，连深色衬底都不画，面板整个是透明的。
       *   两种情况下用户看到的都是"看不出面板边界"（2026-10-16 反馈）。
       *
       *   垫一层接近不透明的底就都解决了：玻璃正常时透出这层底、抓取失败时
       *   也有实底兜着。用 `barSolid`（Tab 栏"没有玻璃兜着时"的那档实底）
       *   而不是 `surface` —— 后者只有 0.06 的白，等于没垫。
       */
      backgroundColor: color.barSolid,
      // 浮起来：跟底下那块播放详情拉开层次
      elevation: 16,
      shadowColor: '#000',
      shadowOpacity: 0.45,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: -6 },
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: space.md,
    },
    title: { color: color.text, fontSize: 17, fontWeight: '700' },
    refresh: { color: color.accent, fontSize: 14 },
    refreshBusy: { color: color.textFaint },
    airplayRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    airplayButton: { width: 40, height: 40 },
    // ★ flexShrink 必须有：sheet 只有 maxHeight，不给 ScrollView 收缩的话
    //   它会按内容高度撑开、被父级 overflow:hidden 裁掉，滚不动。
    list: { marginTop: space.xs, flexShrink: 1 },
    listContent: { paddingBottom: space.sm },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    deviceText: { flex: 1, paddingRight: space.md },
    deviceName: { color: color.text, fontSize: 15 },
    deviceMeta: { color: color.textFaint, fontSize: 12, marginTop: 2 },
    castAction: { color: color.accent, fontSize: 14, fontWeight: '600' },
    empty: { alignItems: 'center', paddingVertical: space.xl },
    emptyTitle: { color: color.textDim, fontSize: 15, marginBottom: space.sm },
    emptyHint: {
      color: color.textFaint,
      fontSize: 12,
      lineHeight: 19,
      textAlign: 'center',
    },
    error: { color: color.danger, fontSize: 12, lineHeight: 18, marginBottom: space.sm },
    casting: {
      backgroundColor: color.surface,
      borderRadius: radius.md,
      padding: space.md,
      marginBottom: space.md,
    },
    castingTitle: { color: color.text, fontSize: 15, fontWeight: '600' },
    castingMeta: { color: color.textDim, fontSize: 12, marginTop: 3 },
    warn: { color: color.accent, fontSize: 12, marginTop: space.sm, lineHeight: 18 },
    castUrl: {
      color: color.textFaint,
      fontSize: 10,
      lineHeight: 15,
      marginTop: space.sm,
    },
    castingActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
    action: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: space.sm,
      borderRadius: radius.sm,
      backgroundColor: color.surfaceStrong,
    },
    actionDanger: { backgroundColor: 'rgba(255,107,107,0.16)' },
    actionText: { color: color.text, fontSize: 14 },
    actionTextDanger: { color: color.danger, fontWeight: '600' },
  });
