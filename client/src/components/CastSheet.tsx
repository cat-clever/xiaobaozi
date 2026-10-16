/**
 * 投屏设备抽屉（液态玻璃底部弹层）。
 *
 * 交互见文档 §5.5.5：设备列表实时刷新、空列表给引导、投屏中显示"正在投屏到 X"
 * 并给一个遥控器。
 *
 * ★ 直投 / 转发**必须在界面上说清楚**（文档 §5.5.4 的"已知限制"）：
 *   转发模式流经手机，手机一休眠投屏就断 —— 不提示的话用户会以为是 App 坏了。
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AirPlayButton, AIRPLAY_AVAILABLE } from './AirPlayButton';
import { GlassBox } from './GlassBox';
import { radius, space, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { CastDevice, CastTransportState } from '../cast/types';

/** 正在投的那一台 */
export interface ActiveCast {
  device: CastDevice;
  direct: boolean;
  lineName: string;
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
        <GlassBox style={styles.sheet} cornerRadius={radius.lg}>
          <View style={styles.header}>
            <Text style={styles.title}>投屏</Text>
            <Pressable onPress={onRefresh} hitSlop={10} disabled={scanning}>
              <Text style={[styles.refresh, scanning && styles.refreshBusy]}>
                {scanning ? '搜索中…' : '刷新'}
              </Text>
            </Pressable>
          </View>

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

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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
      {/* ★ 转发模式必须把这条讲出来（文档 §5.5.4） */}
      {!active.direct ? (
        <Text style={styles.warn}>转发模式：投屏期间请别让手机息屏或退出 App</Text>
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
    scrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.45)',
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
    list: { marginTop: space.xs },
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
