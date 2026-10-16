import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { GlassBox } from '../components/GlassBox';
import { radius, space, useTheme } from '../theme';
import type { Palette, ThemeMode } from '../theme';
import { formatSize, shortDate } from '../update/manifest';
import {
  RELEASE_PAGE_URL,
  SIDESTORE_SOURCE_URL,
  checkForUpdate,
  downloadAndInstall,
  isUpdaterAvailable,
  openExternal,
  useUpdateState,
} from '../update/updater';

interface Props {
  onBack: () => void;
}

const MODES: Array<{ id: ThemeMode; label: string; hint: string }> = [
  { id: 'system', label: '跟随系统', hint: '系统切深色它就切' },
  { id: 'dark', label: '深色', hint: '默认' },
  { id: 'light', label: '亮色', hint: '' },
];

/** 设置页：外观 / 液态玻璃 / 更新 */
export function SettingsScreen({ onBack }: Props): React.JSX.Element {
  const { color, mode, glass, setMode, setGlass } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);

  const update = useUpdateState();
  /** 端内安装失败的原因（"没允许安装未知应用"最常见） */
  const [installError, setInstallError] = useState<string | null>(null);

  /**
   * 进设置页就查一次（`idle` 才查：App 启动时已经静默查过一轮，
   * 用户没手动点的话没必要为一次进页面再打一次网络）。
   */
  useEffect(() => {
    if (update.phase === 'idle') void checkForUpdate();
  }, [update.phase]);

  const manifest = update.manifest;
  const newer = update.phase === 'available' && !!manifest;

  const onInstall = useCallback(async () => {
    if (!manifest?.androidUrl) {
      setInstallError('清单里没有 APK 地址，去发布页手动下载');
      return;
    }
    setInstallError(null);
    try {
      await downloadAndInstall(manifest.androidUrl);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setInstallError(
        err?.code === 'NEED_PERMISSION'
          ? '要先允许「安装未知应用」：在系统设置里给本应用打开这个开关，然后回来再点一次。'
          : err?.message || '下载失败，请稍后重试',
      );
    }
  }, [manifest]);

  /**
   * 「当前版本」那一行。
   *
   * ★ 只显示**版本名**；Android 后面括号里带 `versionCode`。
   *   iOS 的 `CFBundleVersion` 是构建号、不参与版本比较，
   *   显示出来会被当成"版本号是 15"，反而看不懂（踩过）。
   */
  const currentLabel = update.current
    ? update.current.version
      ? `${update.current.version}${
          Platform.OS === 'android' && update.current.versionCode
            ? ` (${update.current.versionCode})`
            : ''
        }`
      : '读不到'
    : '读取中…';

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} style={styles.back}>
        <Text style={styles.backText}>‹ 返回</Text>
      </Pressable>

      <Text style={styles.title}>设置</Text>

      <Text style={styles.sectionTitle}>外观</Text>
      <GlassBox style={styles.card}>
        {MODES.map((item, index) => (
          <Pressable
            key={item.id}
            style={[styles.row, index > 0 && styles.rowDivided]}
            onPress={() => setMode(item.id)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowLabel}>{item.label}</Text>
              {item.hint ? <Text style={styles.rowHint}>{item.hint}</Text> : null}
            </View>
            <View style={[styles.radio, mode === item.id && styles.radioOn]}>
              {mode === item.id ? <View style={styles.radioDot} /> : null}
            </View>
          </Pressable>
        ))}
      </GlassBox>

      <Text style={styles.sectionTitle}>液态玻璃</Text>
      <GlassBox style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>玻璃材质</Text>
            <Text style={styles.rowHint}>
              {glass
                ? 'iOS 真背景模糊 · Android 渐变近似'
                : '关掉后退回纯色面板，更省电'}
            </Text>
          </View>
          <Switch
            value={glass}
            onValueChange={setGlass}
            trackColor={{ false: color.surfaceStrong, true: color.accent }}
            thumbColor="#FFFFFF"
          />
        </View>
      </GlassBox>

      {/*
        ★ 更新：Android 是**真·端内升级**（APK 固定签名，下载完直接交给系统
          安装器覆盖安装）；iOS 的 IPA 是未签名的，系统不允许 App 自己装自己 ——
          那边只做到"发现新版本 + 把你送到发布页 / SideStore 源"。
          两端的差别见 `src/update/updater.ts` 顶部。
      */}
      <Text style={styles.sectionTitle}>更新</Text>
      <GlassBox style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowLabel}>当前版本</Text>
            <Text style={styles.rowHint}>{currentLabel}</Text>
          </View>
          <Pressable
            onPress={() => void checkForUpdate()}
            disabled={update.phase === 'checking'}
            style={styles.checkBtn}>
            <Text style={styles.checkText}>
              {update.phase === 'checking' ? '检查中…' : '检查更新'}
            </Text>
          </Pressable>
        </View>

        {update.phase === 'latest' ? (
          <View style={styles.row}>
            <Text style={styles.statusOk}>已是最新版本</Text>
          </View>
        ) : null}
        {update.phase === 'error' ? (
          <View style={styles.row}>
            <Text style={styles.statusBad}>{update.error ?? '检查失败'}</Text>
          </View>
        ) : null}
      </GlassBox>

      {newer && manifest ? (
        <>
          <Text style={styles.sectionTitle}>
            发现新版本 {manifest.version}
          </Text>
          <GlassBox style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>
                  小包子影视 {manifest.version}
                </Text>
                <Text style={styles.rowHint}>
                  {[
                    shortDate(manifest.publishedAt),
                    formatSize(manifest.androidSize),
                  ]
                    .filter(Boolean)
                    .join(' · ') || '有新版本可以升级'}
                </Text>
              </View>
            </View>

            {manifest.notes.length ? (
              <View style={styles.notes}>
                {manifest.notes.slice(0, 12).map((line, index) => (
                  <Text key={`${index}-${line}`} style={styles.note}>
                    · {line}
                  </Text>
                ))}
              </View>
            ) : null}

            <View style={styles.row}>
              {isUpdaterAvailable() ? (
                <Pressable
                  style={[styles.actionBtn, update.installing && styles.actionOff]}
                  disabled={update.progress !== null || update.installing}
                  onPress={() => void onInstall()}>
                  <Text style={styles.actionText}>
                    {update.installing
                      ? '已交给系统安装'
                      : update.progress !== null
                      ? `下载中 ${Math.round(update.progress * 100)}%`
                      : `下载并安装${
                          formatSize(manifest.androidSize)
                            ? `（${formatSize(manifest.androidSize)}）`
                            : ''
                        }`}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() =>
                    openExternal(manifest.pageUrl || RELEASE_PAGE_URL)
                  }>
                  <Text style={styles.actionText}>打开发布页</Text>
                </Pressable>
              )}
            </View>

            {/*
              ★ iOS 说明必须写清楚：不是我们不想做端内升级，
                是未签名 IPA 没有合法的自安装路径。
            */}
            {Platform.OS === 'ios' ? (
              <View style={styles.notes}>
                <Text style={styles.note}>
                  iOS 的 IPA 是未签名的，系统不允许 App 自己装自己 ——
                  这里只能把你送到发布页。
                </Text>
                <Text style={styles.note}>
                  装了 SideStore 的话，用它的更新源刷新即可（地址见下）。
                </Text>
                <Text selectable style={styles.sourceUrl}>
                  {SIDESTORE_SOURCE_URL}
                </Text>
              </View>
            ) : null}

            {installError ? (
              <View style={styles.notes}>
                <Text style={styles.statusBad}>{installError}</Text>
              </View>
            ) : null}
          </GlassBox>
        </>
      ) : null}

      <Text style={styles.footer}>小包子影视</Text>
    </ScrollView>
  );
}

const makeStyles = (color: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, paddingBottom: space.xl * 3 },
    back: { paddingVertical: space.sm, marginBottom: space.sm },
    backText: { color: color.accent, fontSize: 15 },
    title: { color: color.text, fontSize: 24, fontWeight: '700' },
    sectionTitle: {
      color: color.textFaint,
      fontSize: 12,
      marginTop: space.xl,
      marginBottom: space.sm,
      marginLeft: space.xs,
    },
    card: { borderRadius: radius.lg, overflow: 'hidden' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    rowDivided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    rowMain: { flex: 1 },
    rowLabel: { color: color.text, fontSize: 15 },
    rowHint: { color: color.textFaint, fontSize: 12, marginTop: 2 },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: color.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOn: { borderColor: color.accent },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
    checkBtn: {
      paddingHorizontal: space.lg,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceStrong,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.glassBorder,
    },
    checkText: { color: color.text, fontSize: 13 },
    statusOk: { color: color.accent, fontSize: 13 },
    statusBad: { color: color.danger, fontSize: 13, lineHeight: 19 },
    notes: {
      paddingHorizontal: space.lg,
      paddingBottom: space.md,
      gap: 3,
    },
    note: { color: color.textDim, fontSize: 13, lineHeight: 19 },
    sourceUrl: {
      color: color.textFaint,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 2,
    },
    actionBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: space.md,
      borderRadius: radius.pill,
      backgroundColor: color.accent,
    },
    actionOff: { opacity: 0.6 },
    actionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
    footer: {
      color: color.textFaint,
      fontSize: 12,
      textAlign: 'center',
      marginTop: space.xl * 2,
    },
  });
