import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { homeBlocksOf, peekHomeBlocks, sourceLabel } from '../api/aggregator';
import { MediaCard } from '../components/MediaCard';
import {
  enterHorizontalRow,
  leaveHorizontalRow,
} from '../components/horizontalRow';
import { radius, space, useTabBarSpace, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { HomeBlock } from '../api/aggregator';
import type { SourceId, VodItem } from '../types/schema';

const GAP = space.md;
/** 一屏横向能看见几列 —— 电视横屏宽，多放几列 */
const VISIBLE_COLUMNS = Platform.isTV ? 6 : 3;
/** 每个板块上下几排 */
const ROWS = 2;
/** 骨架屏先铺几个板块 */
const SKELETON_BLOCKS = 2;

const CARD_WIDTH =
  (Dimensions.get('window').width -
    space.lg * 2 -
    GAP * (VISIBLE_COLUMNS - 1)) /
  VISIBLE_COLUMNS;

/** 展示顺序：全网源在上、精选源在下 */
const SOURCES: SourceId[] = ['s1', 's2'];

interface Props {
  onOpen: (item: VodItem) => void;
}

/**
 * 每个源**各自**的加载状态。
 *
 * ★ 实测（2026-10-15）：源2 一次回 8 个板块共 **347 张卡片**，全量渲染就是
 *   首屏卡 2-3 秒的主因（网络只要 350-570ms）。现在每个板块改成
 *   **上下两排、横向滚动**的虚拟化列表，一屏只渲染可见的那十几张。
 */
interface SourceState {
  blocks: HomeBlock[];
  loading: boolean;
  error: string | null;
}

const freshState = (): Record<SourceId, SourceState> => ({
  s1: { blocks: [], loading: true, error: null },
  s2: { blocks: [], loading: true, error: null },
});

/**
 * 初始状态：**有缓存就直接用它**。
 *
 * 进详情页 / 播放页时整个 Tab 树会卸载，返回时首页重新挂载 ——
 * 没有这一步的话每次返回都要重拉两个源，还要先闪一下骨架屏。
 */
const initialState = (): Record<SourceId, SourceState> => {
  const out = freshState();
  for (const id of SOURCES) {
    const cached = peekHomeBlocks(id);
    if (cached) out[id] = { blocks: cached, loading: false, error: null };
  }
  return out;
};

/** 把条目按每列 ROWS 个切成列 —— 横向滚动时每一列就是上下两排 */
function toColumns(items: VodItem[], rows: number): VodItem[][] {
  const out: VodItem[][] = [];
  for (let i = 0; i < items.length; i += rows)
    out.push(items.slice(i, i + rows));
  return out;
}

export function HomeScreen({ onOpen }: Props): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  const [state, setState] =
    useState<Record<SourceId, SourceState>>(initialState);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    // ★ 已经有缓存、又不是下拉刷新 —— 这一家**不用再打**。
    //   首次进入两家都没缓存，正常拉；从详情页返回时两家都有缓存，
    //   于是这里一个请求都不发，首页秒出。
    const targets = SOURCES.filter(id => isRefresh || !peekHomeBlocks(id));

    if (isRefresh) setRefreshing(true);

    if (targets.length) {
      setState(prev => {
        const next = { ...prev };
        for (const id of targets)
          next[id] = { ...prev[id], loading: true, error: null };
        return next;
      });

      // await 的只是"这些请求都结束"，不是"都拿到数据才渲染" ——
      // 每个源各自 setState，先到的先画。
      await Promise.all(
        targets.map(async id => {
          try {
            const blocks = await homeBlocksOf(id, 1, isRefresh);
            setState(prev => ({
              ...prev,
              [id]: { blocks, loading: false, error: null },
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setState(prev => ({
              ...prev,
              [id]: {
                blocks: [],
                loading: false,
                error: `${sourceLabel(id)}：${message}`,
              },
            }));
          }
        }),
      );
    }

    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blocks: HomeBlock[] = SOURCES.flatMap(id => state[id].blocks);
  const errors = SOURCES.map(id => state[id].error).filter(
    (e): e is string => !!e,
  );
  const stillLoading = SOURCES.some(id => state[id].loading);

  // 还一条都没有：整屏骨架
  if (blocks.length === 0 && stillLoading) {
    return (
      <ScrollView contentContainerStyle={styles.content} scrollEnabled={false}>
        {Array.from({ length: SKELETON_BLOCKS }, (_, i) => (
          <SkeletonBlock key={i} />
        ))}
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={blocks}
      keyExtractor={(block, index) => `${block.title}-${index}`}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          tintColor={color.accent}
        />
      }
      ListHeaderComponent={
        errors.length ? (
          <View style={styles.errorBox}>
            {errors.map(e => (
              <Text key={e} style={styles.errorText}>
                {e}
              </Text>
            ))}
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.hint}>两个源都没有返回内容，下拉重试。</Text>
        </View>
      }
      // 一家到了、另一家还没到：下面补一块骨架，别让页面看着像加载完了
      ListFooterComponent={stillLoading ? <SkeletonBlock /> : undefined}
      renderItem={({ item: block }) => <Block block={block} onOpen={onOpen} />}
    />
  );
}

/** 一个板块：标题 + 上下两排、横向滚动的卡片 */
function Block({
  block,
  onOpen,
}: {
  block: HomeBlock;
  onOpen: (item: VodItem) => void;
}): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  const columns = useMemo(() => toColumns(block.items, ROWS), [block.items]);

  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>{block.title}</Text>
      {/*
        ★ 在这一片按下的横滑是**给板块自己滚的**，分页器不许抢 ——
          按下时打个标记，分页器的手势判断会读它。
      */}
      <View
        onTouchStart={enterHorizontalRow}
        onTouchEnd={leaveHorizontalRow}
        onTouchCancel={leaveHorizontalRow}
      >
        <FlatList
          horizontal
          data={columns}
          keyExtractor={(column, index) => `${index}-${column[0]?.id ?? ''}`}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rowContent}
          initialNumToRender={VISIBLE_COLUMNS + 1}
          maxToRenderPerBatch={VISIBLE_COLUMNS}
          windowSize={3}
          renderItem={({ item: column }) => (
            <View style={styles.column}>
              {column.map(item => (
                <MediaCard
                  key={item.id}
                  item={item}
                  width={CARD_WIDTH}
                  onPress={onOpen}
                />
              ))}
            </View>
          )}
        />
      </View>
    </View>
  );
}

/** 骨架屏：一块标题条 + 两排灰卡片，呼吸式闪烁 */
function SkeletonBlock(): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.85,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.block}>
      <Animated.View style={[styles.skeletonTitle, { opacity: pulse }]} />
      <View style={styles.rowContent}>
        {Array.from({ length: VISIBLE_COLUMNS }, (_unused, col) => (
          <View key={col} style={styles.column}>
            {Array.from({ length: ROWS }, (_row, row) => (
              <Animated.View
                key={row}
                style={[
                  styles.skeletonCard,
                  {
                    width: CARD_WIDTH,
                    height: CARD_WIDTH * 1.4,
                    opacity: pulse,
                  },
                ]}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (color: Palette, tabBarSpace: number) =>
  StyleSheet.create({
    content: { padding: space.lg, paddingBottom: tabBarSpace },
    center: { alignItems: 'center', paddingVertical: space.xl * 2 },
    hint: { color: color.textDim, fontSize: 13 },
    block: { marginBottom: space.xl },
    blockTitle: {
      color: color.text,
      fontSize: 16,
      fontWeight: '600',
      marginBottom: space.md,
    },
    // 横向列表的内容容器；骨架屏直接复用，保证两边排版一致
    rowContent: { flexDirection: 'row', gap: GAP, paddingRight: space.lg },
    column: { gap: 0 },
    skeletonTitle: {
      width: 120,
      height: 16,
      borderRadius: 4,
      backgroundColor: color.surfaceStrong,
      marginBottom: space.md,
    },
    skeletonCard: {
      borderRadius: radius.md,
      backgroundColor: color.surfaceStrong,
      marginBottom: space.lg,
    },
    errorBox: {
      backgroundColor: 'rgba(255,107,107,0.12)',
      borderRadius: radius.md,
      padding: space.md,
      marginBottom: space.lg,
    },
    errorText: { color: color.danger, fontSize: 12, lineHeight: 18 },
  });
