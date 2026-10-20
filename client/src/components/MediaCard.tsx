import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Pressable } from './FocusablePressable';
import { radius, space, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { VodItem } from '../types/schema';

interface Props {
  item: VodItem;
  width: number;
  onPress: (item: VodItem) => void;
}

/** 影视海报卡片。左上角带来源角标（**两个源颜色不同**，见下面的 badgeS1 / badgeS2） */
export function MediaCard({ item, width, onPress }: Props): React.JSX.Element {
  const { color } = useTheme();
  const styles = useMemo(() => makeStyles(color), [color]);
  const isS1 = item.sourceId === 's1';
  const badge = isS1 ? '全网源' : '精选源';
  return (
    <Pressable style={[styles.card, { width }]} onPress={() => onPress(item)}>
      <View style={[styles.poster, { height: width * 1.4 }]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={[styles.image, styles.placeholder]} />
        )}
        <View style={[styles.badge, isS1 ? styles.badgeS1 : styles.badgeS2]}>
          <Text style={[styles.badgeText, isS1 ? styles.badgeTextS1 : styles.badgeTextS2]}>
            {badge}
          </Text>
        </View>
        {item.remarks ? (
          <View style={styles.remarks}>
            <Text style={styles.remarksText} numberOfLines={1}>
              {item.remarks}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {item.title}
      </Text>
      {item.year || item.rating ? (
        <Text style={styles.meta} numberOfLines={1}>
          {[item.year, item.rating].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (color: Palette) =>
  StyleSheet.create({
    card: { marginBottom: space.lg },
    poster: {
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    image: { width: '100%', height: '100%' },
    placeholder: { backgroundColor: color.surfaceStrong },
    badge: {
      position: 'absolute',
      top: space.sm,
      left: space.sm,
      paddingHorizontal: space.sm,
      paddingVertical: 3,
      borderRadius: radius.pill,
    },
    // ★ 按源配色（不是两源一个样）：精选源=主题橙，全网源=高对比黑胶囊。
    //   字号也从 10 加到 11 并加粗 —— 海报一花，小字半透明胶囊根本认不出是哪个源。
    badgeS1: { backgroundColor: color.badgeS1 },
    badgeS2: { backgroundColor: color.badgeS2 },
    badgeText: { fontSize: 11, fontWeight: '600' },
    badgeTextS1: { color: color.badgeS1Text },
    badgeTextS2: { color: color.badgeS2Text },
    remarks: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      paddingHorizontal: space.sm,
      paddingVertical: 4,
      backgroundColor: color.scrim,
    },
    remarksText: { color: color.text, fontSize: 10 },
    title: { color: color.text, fontSize: 13, marginTop: space.sm, lineHeight: 18 },
    meta: { color: color.textFaint, fontSize: 11, marginTop: 2 },

  });
