import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { hotSearch, searchAll } from '../api/aggregator';
import { MediaCard } from '../components/MediaCard';
import { pushSearchHistory, getSearchHistory } from '../utils/storage';
import { radius, space, useTabBarSpace, useTheme } from '../theme';
import type { Palette } from '../theme';
import type { VodItem } from '../types/schema';

const GAP = space.md;
const COLUMNS = 3;
const CARD_WIDTH =
  (Dimensions.get('window').width - space.lg * 2 - GAP * (COLUMNS - 1)) / COLUMNS;

interface Props {
  onOpen: (item: VodItem) => void;
}

export function SearchScreen({ onOpen }: Props): React.JSX.Element {
  const { color } = useTheme();
  const tabBarSpace = useTabBarSpace();
  const styles = useMemo(
    () => makeStyles(color, tabBarSpace),
    [color, tabBarSpace],
  );
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<VodItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [hot, setHot] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    void getSearchHistory().then(setHistory);
    void hotSearch().then(setHot);
  }, []);

  const run = useCallback(
    async (kw: string) => {
      const trimmed = kw.trim();
      if (!trimmed) return;
      setLoading(true);
      setErrors([]);
      try {
        const result = await searchAll(trimmed);
        setItems(result.items);
        setErrors(result.errors);
        setHistory(await pushSearchHistory(trimmed));
      } catch (err) {
        setErrors([err instanceof Error ? err.message : String(err)]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const showSuggestions = items.length === 0 && !loading;

  return (
    <View style={styles.root}>
      <View style={styles.searchBar}>
        <TextInput
          style={styles.input}
          value={keyword}
          onChangeText={setKeyword}
          placeholder="搜剧名、演员…"
          placeholderTextColor={color.textFaint}
          returnKeyType="search"
          onSubmitEditing={() => void run(keyword)}
        />
        <Pressable style={styles.button} onPress={() => void run(keyword)}>
          <Text style={styles.buttonText}>搜索</Text>
        </Pressable>
      </View>

      {errors.length ? (
        <View style={styles.errorBox}>
          {errors.map((e) => (
            <Text key={e} style={styles.errorText}>
              {e}
            </Text>
          ))}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.accent} />
        </View>
      ) : null}

      {showSuggestions ? (
        <View style={styles.suggestions}>
          {history.length ? (
            <>
              <Text style={styles.sectionTitle}>最近搜索</Text>
              <View style={styles.chips}>
                {history.map((h) => (
                  <Pressable
                    key={h}
                    style={styles.chip}
                    onPress={() => {
                      setKeyword(h);
                      void run(h);
                    }}>
                    <Text style={styles.chipText}>{h}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
          {hot.length ? (
            <>
              <Text style={styles.sectionTitle}>热搜</Text>
              <View style={styles.chips}>
                {hot.slice(0, 20).map((h) => (
                  <Pressable
                    key={h}
                    style={styles.chip}
                    onPress={() => {
                      setKeyword(h);
                      void run(h);
                    }}>
                    <Text style={styles.chipText}>{h}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <MediaCard item={item} width={CARD_WIDTH} onPress={onOpen} />
        )}
      />
    </View>
  );
}

const makeStyles = (color: Palette, tabBarSpace: number) =>
  StyleSheet.create({
    root: { flex: 1 },
    searchBar: {
      flexDirection: 'row',
      padding: space.lg,
      gap: space.sm,
    },
    input: {
      flex: 1,
      height: 40,
      borderRadius: radius.pill,
      paddingHorizontal: space.lg,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      color: color.text,
    },
    button: {
      paddingHorizontal: space.lg,
      height: 40,
      borderRadius: radius.pill,
      backgroundColor: color.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: { color: '#1A1206', fontWeight: '600' },
    list: { paddingHorizontal: space.lg, paddingBottom: tabBarSpace },
    row: { gap: GAP },
    center: { paddingVertical: space.xl },
    suggestions: { paddingHorizontal: space.lg },
    sectionTitle: {
      color: color.textDim,
      fontSize: 12,
      marginTop: space.lg,
      marginBottom: space.sm,
    },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    chipText: { color: color.text, fontSize: 12 },
    errorBox: {
      marginHorizontal: space.lg,
      backgroundColor: 'rgba(255,107,107,0.12)',
      borderRadius: radius.md,
      padding: space.md,
    },
    errorText: { color: color.danger, fontSize: 12, lineHeight: 18 },

  });
