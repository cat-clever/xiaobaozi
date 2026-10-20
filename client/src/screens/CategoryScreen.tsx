import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Platform,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Pressable } from '../components/FocusablePressable';
import {
  SOURCE_LABEL,
  listByCategory,
  s1CategoryTree,
  s1FilterRowsFor,
  s2CategoryTree,
} from '../api/aggregator';
import type { CategoryQuery, FilterRow } from '../api/aggregator';
import type { CategoryTree as S1Tree } from '../api/source1';
import type { CategoryTree as S2Tree } from '../api/source2';
import { MediaCard } from '../components/MediaCard';
import {
  enterHorizontalRow,
  leaveHorizontalRow,
} from '../components/horizontalRow';
import { radius, space, useTabBarSpace, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { SourceId, VodItem } from '../types/schema';

const GAP = space.md;
/** 电视横屏宽，多放几列 */
const COLUMNS = Platform.isTV ? 6 : 3;
const CARD_WIDTH =
  (Dimensions.get('window').width - space.lg * 2 - GAP * (COLUMNS - 1)) /
  COLUMNS;

const SOURCES: SourceId[] = ['s1', 's2'];

/**
 * 两个源的筛选条件各存一份 —— 切回来时不必从头选。
 *
 * ★ 两边的维度完全不同，**不硬抹平成一套**：
 *   源1 是「分类 -> 每个分类各有自己的题材/地区/年份/排序」，
 *   源2 是「三组大类 -> 每组各自的细分 + 年份 + 排序」。
 */
interface S1Filter {
  typeId: number;
  genre: string;
  tag: string;
  area: string;
  year: string;
  sort: string;
}

interface S2Filter {
  stype: number | null;
  cid: number | null;
  year: string;
  sort: string;
}

const EMPTY_S1: S1Filter = {
  typeId: 0,
  genre: '',
  tag: '',
  area: '',
  year: '',
  sort: '',
};
const EMPTY_S2: S2Filter = { stype: null, cid: null, year: '', sort: '' };

/**
 * 分类页缓存（**进程内**，App 不关就一直有效）—— 跟首页同一套思路。
 *
 * 按「源 + 筛选条件」缓存**第 1 页**：进详情页再回来、或者在 Tab 之间来回切，
 * 同一组筛选条件不用重查。翻到第 2 页之后的部分不缓存（那本来就是按需拉的）。
 *
 * 下拉刷新会绕过缓存重取。
 */
const firstPageCache = new Map<string, VodItem[]>();

const cacheKeyOf = (source: SourceId, query: CategoryQuery): string =>
  `${source}|${JSON.stringify(query)}`;

interface Props {
  onOpen: (item: VodItem) => void;
}

export function CategoryScreen({ onOpen }: Props): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  const [source, setSource] = useState<SourceId>('s1');
  const [s1Filter, setS1Filter] = useState<S1Filter>(EMPTY_S1);
  const [s2Filter, setS2Filter] = useState<S2Filter>(EMPTY_S2);

  const [tree1, setTree1] = useState<S1Tree | null>(null);
  const [tree2, setTree2] = useState<S2Tree | null>(null);

  const [items, setItems] = useState<VodItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageRef = useRef(1);
  const requestRef = useRef(0);

  // ---------- 分类树：两个源各自拉一次 ----------
  useEffect(() => {
    let alive = true;
    s1CategoryTree()
      .then(tree => alive && setTree1(tree))
      .catch(() => undefined);
    s2CategoryTree()
      .then(tree => alive && setTree2(tree))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // ---------- 当前筛选条件 ----------
  const query: CategoryQuery = useMemo(
    () =>
      source === 's1'
        ? {
            typeId: s1Filter.typeId,
            typeValue: s1Filter.genre,
            tagType: s1Filter.tag,
            area: s1Filter.area,
            year: s1Filter.year,
            sort: s1Filter.sort,
          }
        : {
            stype: s2Filter.stype,
            cid: s2Filter.cid,
            year: s2Filter.year,
            sort: s2Filter.sort,
          },
    [source, s1Filter, s2Filter],
  );

  const queryKey = cacheKeyOf(source, query);

  const load = useCallback(
    async (page: number, append: boolean) => {
      const ticket = (requestRef.current += 1);
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append) setError(null);

      try {
        const list = await listByCategory(source, { ...query, page });
        // 竞态：筛选条件在请求飞回来之前又变了，这批结果作废
        if (ticket !== requestRef.current) return;

        setItems(prev => (append ? [...prev, ...list] : list));
        setReachedEnd(list.length === 0);
        pageRef.current = page;

        // 只有第 1 页、且真的拿到内容才写缓存 —— 空结果存进去下次就一直是空的
        if (!append && page === 1 && list.length) {
          firstPageCache.set(cacheKeyOf(source, query), list);
        }
      } catch (err) {
        if (ticket === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          if (!append) setItems([]);
        }
      } finally {
        if (ticket === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [source, query],
  );

  // 筛选条件一变就从第一页重来（有缓存就直接用，不重拉）
  useEffect(() => {
    pageRef.current = 1;
    setReachedEnd(false);

    const cached = firstPageCache.get(queryKey);
    if (cached) {
      requestRef.current += 1; // 作废在飞的请求，别让旧结果覆盖缓存
      setItems(cached);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }

    void load(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  /** 下拉刷新：绕过缓存重新拉第 1 页 */
  const onRefresh = useCallback(() => {
    firstPageCache.delete(cacheKeyOf(source, query));
    void load(1, false);
  }, [source, query, load]);

  const onEndReached = useCallback(() => {
    if (loading || loadingMore || reachedEnd) return;
    void load(pageRef.current + 1, true);
  }, [load, loading, loadingMore, reachedEnd]);

  // ---------- 筛选行 ----------
  const rows: FilterRow[] = useMemo(() => {
    if (source === 's1') {
      if (!tree1) return [];
      const categoryRow: FilterRow = {
        title: '分类',
        options: [
          { label: '全部', value: '0' },
          ...tree1.categories.map(c => ({
            label: c.label,
            value: String(c.value),
          })),
        ],
      };
      return [
        categoryRow,
        ...s1FilterRowsFor(tree1, s1Filter.typeId, s1Filter.genre),
      ];
    }
    if (!tree2) return [];

    const groupRow: FilterRow = {
      title: '频道',
      options: tree2.groups.map(g => ({
        label: g.label,
        value: String(g.value),
      })),
    };
    const current = tree2.groups.find(
      g => String(g.value) === String(s2Filter.stype),
    );
    const rows2: FilterRow[] = [groupRow];
    if (current?.cates.length)
      rows2.push({ title: '细分', options: current.cates });
    if (tree2.years.length) rows2.push({ title: '年份', options: tree2.years });
    if (tree2.sorts.length) rows2.push({ title: '排序', options: tree2.sorts });
    return rows2;
  }, [source, tree1, tree2, s1Filter.typeId, s1Filter.genre, s2Filter.stype]);

  /** 当前某个维度选中的值 */
  const selectedIn = useCallback(
    (title: string): string => {
      if (source === 's1') {
        switch (title) {
          case '分类':
            return String(s1Filter.typeId);
          case '题材':
            return s1Filter.genre;
          case '标签':
            return s1Filter.tag;
          case '地区':
            return s1Filter.area;
          case '年份':
            return s1Filter.year;
          case '排序':
            return s1Filter.sort;
          default:
            return '';
        }
      }
      switch (title) {
        case '频道':
          return s2Filter.stype === null ? '' : String(s2Filter.stype);
        case '细分':
          return s2Filter.cid === null ? '' : String(s2Filter.cid);
        case '年份':
          return s2Filter.year;
        case '排序':
          return s2Filter.sort;
        default:
          return '';
      }
    },
    [source, s1Filter, s2Filter],
  );

  const pick = useCallback(
    (title: string, value: string) => {
      if (source === 's1') {
        setS1Filter(prev => {
          switch (title) {
            case '分类':
              // 换分类要把细分维度清空，否则会带着上一个分类的题材去筛，出来的多半是空
              return { ...EMPTY_S1, typeId: Number(value) };
            case '题材':
              // 二级标签是按题材下标给的，换题材必须一起清掉
              return { ...prev, genre: value, tag: '' };
            case '标签':
              return { ...prev, tag: value };
            case '地区':
              return { ...prev, area: value };
            case '年份':
              return { ...prev, year: value };
            case '排序':
              return { ...prev, sort: value };
            default:
              return prev;
          }
        });
        return;
      }
      setS2Filter(prev => {
        switch (title) {
          case '频道':
            return { ...EMPTY_S2, stype: value === '' ? null : Number(value) };
          case '细分':
            return { ...prev, cid: value === '' ? null : Number(value) };
          case '年份':
            return { ...prev, year: value };
          case '排序':
            return { ...prev, sort: value };
          default:
            return prev;
        }
      });
    },
    [source],
  );

  const header = (
    <View>
      <View style={styles.sourceTabs}>
        {SOURCES.map(id => (
          <Pressable
            key={id}
            style={[styles.sourceTab, source === id && styles.sourceTabActive]}
            onPress={() => setSource(id)}
          >
            <Text
              style={[
                styles.sourceTabText,
                source === id && styles.sourceTabTextActive,
              ]}
            >
              {SOURCE_LABEL[id]}
            </Text>
          </Pressable>
        ))}
      </View>

      {rows.map(row => (
        <FilterRowView
          key={row.title}
          row={row}
          selected={selectedIn(row.title)}
          onPick={value => pick(row.title, value)}
        />
      ))}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );

  return (
    <FlatList
      data={items}
      key={`grid-${COLUMNS}`}
      numColumns={COLUMNS}
      keyExtractor={item => item.id}
      columnWrapperStyle={styles.column}
      contentContainerStyle={styles.content}
      ListHeaderComponent={header}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={onRefresh}
          tintColor={color.accent}
        />
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      ListEmptyComponent={
        loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={color.accent} />
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.hint}>这个筛选下没有内容</Text>
          </View>
        )
      }
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.center}>
            <ActivityIndicator color={color.textFaint} size="small" />
          </View>
        ) : !reachedEnd && items.length > 0 ? (
          <Text style={styles.footerHint}>上拉加载更多</Text>
        ) : undefined
      }
      renderItem={({ item }) => (
        <MediaCard item={item} width={CARD_WIDTH} onPress={onOpen} />
      )}
    />
  );
}

/** 一行筛选：标题 + 一排可横向滑动的胶囊 */
function FilterRowView({
  row,
  selected,
  onPick,
}: {
  row: FilterRow;
  selected: string;
  onPick: (value: string) => void;
}): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{row.title}</Text>
      {/* 筛选条也是横向滚动的，同样别让分页器抢 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        onTouchStart={enterHorizontalRow}
        onTouchEnd={leaveHorizontalRow}
        onTouchCancel={leaveHorizontalRow}
      >
        {row.options.map(option => {
          const active = option.value === selected;
          return (
            <Pressable
              key={`${row.title}-${option.label}`}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onPick(option.value)}
            >
              <Text
                style={[styles.chipText, active && styles.chipTextActive]}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (color: Palette, tabBarSpace: number) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingBottom: tabBarSpace },
    column: { gap: GAP },
    sourceTabs: {
      flexDirection: 'row',
      gap: space.sm,
      paddingTop: space.md,
      paddingBottom: space.sm,
    },
    sourceTab: {
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: radius.pill,
      backgroundColor: color.surface,
    },
    sourceTabActive: { backgroundColor: color.accent },
    sourceTabText: { color: color.textDim, fontSize: 13 },
    sourceTabTextActive: { color: '#0b0b0f', fontWeight: '600' },
    row: { marginBottom: space.sm },
    rowTitle: { color: color.textFaint, fontSize: 11, marginBottom: space.xs },
    chips: { gap: space.sm, paddingRight: space.lg },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.sm,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    chipActive: {
      backgroundColor: color.surfaceStrong,
      borderColor: color.accent,
    },
    chipText: { color: color.textDim, fontSize: 12 },
    chipTextActive: { color: color.accent, fontWeight: '600' },
    center: { alignItems: 'center', paddingVertical: space.xl },
    hint: { color: color.textDim, fontSize: 13 },
    footerHint: {
      color: color.textFaint,
      fontSize: 12,
      textAlign: 'center',
      paddingVertical: space.lg,
    },
    error: { color: color.danger, fontSize: 12, marginBottom: space.sm },
  });
