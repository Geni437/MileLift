import React, { Fragment } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { MetricStat } from './MetricStat';

export type MetricBarItem = {
  key: string;
  value: string;
  unit?: string;
  label: string;
};

type Props = {
  items: MetricBarItem[];
  size?: 'primary' | 'inline';
};

/**
 * MetricBar — a horizontal row of 2-3 MetricStats separated by hairline
 * dividers, no cards, no icons (component vocabulary §A). The deliberate
 * anti-pattern to an icon-number-label grid; reinforces the Mile axis's
 * horizontality.
 */
export function MetricBar({ items, size = 'primary' }: Props) {
  return (
    <View style={styles.row}>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: theme.color.border.subtle }]} />}
          <View style={styles.item}>
            <MetricStat value={item.value} unit={item.unit} label={item.label} size={size} />
          </View>
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  item: {
    flex: 1,
  },
  divider: {
    width: theme.border.hairline,
    marginHorizontal: theme.space.md,
  },
});
