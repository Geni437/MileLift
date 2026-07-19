import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../theme';
import type { ActivityCategory, ActivityType } from '../../db/types';

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  foot: 'Foot',
  cycle: 'Cycle',
  water: 'Water',
  winter: 'Winter',
  gym_cardio: 'Gym cardio',
  other: 'Other',
};

const QUICK_ROW_COUNT = 4;

type Props = {
  types: ActivityType[];
  selectedCode: string | null;
  onSelect: (type: ActivityType) => void;
  locked?: boolean;
};

/** TypePicker — quick-row pills over the highest-sort-order types + an "All types" bottom sheet grouped by category (CORE-01). */
export function TypePicker({ types, selectedCode, onSelect, locked }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const quick = useMemo(() => types.slice(0, QUICK_ROW_COUNT), [types]);
  const selected = types.find((t) => t.code === selectedCode) ?? null;

  const grouped = useMemo(() => {
    const map = new Map<ActivityCategory, ActivityType[]>();
    for (const type of types) {
      const list = map.get(type.category) ?? [];
      list.push(type);
      map.set(type.category, list);
    }
    return Array.from(map.entries());
  }, [types]);

  return (
    <View>
      <View style={styles.quickRow}>
        {quick.map((type) => {
          const isSelected = type.code === selectedCode;
          return (
            <Pressable
              key={type.code}
              disabled={locked}
              onPress={() => onSelect(type)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: locked }}
              accessibilityLabel={type.displayName}
              style={[
                styles.chip,
                {
                  backgroundColor: isSelected ? theme.color.accent.primaryTint : theme.color.bg.inset,
                  borderColor: isSelected ? theme.color.accent.primary : theme.color.border.default,
                  opacity: locked && !isSelected ? theme.opacity.disabled : 1,
                },
              ]}
            >
              <Text
                style={[theme.type.label, { color: isSelected ? theme.color.accent.primary : theme.color.text.primary }]}
                maxFontSizeMultiplier={1.6}
              >
                {type.displayName}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          disabled={locked}
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="All activity types"
          accessibilityState={{ disabled: locked }}
          style={[styles.chip, { borderColor: theme.color.border.default, opacity: locked ? theme.opacity.disabled : 1 }]}
        >
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
            All types
          </Text>
        </Pressable>
      </View>

      {locked && selected && (
        <Text style={[theme.type.caption, styles.lockedNote, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={2}>
          Activity type locked while recording.
        </Text>
      )}

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheetOpen(false)} accessibilityLabel="Dismiss" accessibilityRole="button" />
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
              <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>Activity type</Text>
              <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
                {grouped.map(([category, list]) => (
                  <View key={category} style={styles.group}>
                    <Text style={[theme.type.overline, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
                      {CATEGORY_LABEL[category].toUpperCase()}
                    </Text>
                    {list.map((type) => (
                      <Pressable
                        key={type.code}
                        onPress={() => {
                          onSelect(type);
                          setSheetOpen(false);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={type.displayName}
                        style={styles.groupRow}
                      >
                        <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>{type.displayName}</Text>
                      </Pressable>
                    ))}
                  </View>
                ))}
              </ScrollView>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.xs,
  },
  chip: {
    minHeight: theme.touchTarget.min,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.pill,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedNote: {
    marginTop: theme.space.xs,
  },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    width: '100%',
    maxHeight: '80%',
  },
  sheet: {
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    padding: theme.space.lg,
    gap: theme.space.md,
    maxHeight: '100%',
  },
  sheetScroll: {
    flexGrow: 0,
  },
  group: {
    marginBottom: theme.space.md,
    gap: theme.space.xxs,
  },
  groupRow: {
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
});
