import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';

type Option<T extends string> = { label: string; value: T };

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** Shared `radius.pill` segmented control (screens-phase-0.md: Units toggles, onboarding Step 3). */
export function SegmentedControl<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              {
                backgroundColor: selected ? theme.color.accent.primary : theme.color.bg.inset,
                borderColor: theme.color.border.default,
              },
            ]}
          >
            <Text
              style={[
                theme.type.metricSm,
                theme.fontVariation.metric,
                { color: selected ? theme.color.text.onAccent : theme.color.text.primary },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
  segment: {
    flex: 1,
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
