import React from 'react';
import { Text, View } from 'react-native';

import { theme } from '../../theme';
import { SegmentedControl } from '../SegmentedControl';
import { SectionCard } from './SectionCard';
import type { UnitDistance, UnitWeight } from '../../db/types';

type Props = {
  unitWeight: UnitWeight;
  unitDistance: UnitDistance;
  onChange: (fields: { unitWeight?: UnitWeight; unitDistance?: UnitDistance }) => void;
};

/** screens-phase-0.md §F.3: "Changing units changes display only; historical records keep the unit they were logged in." */
export function UnitsSection({ unitWeight, unitDistance, onChange }: Props) {
  return (
    <SectionCard title="Units">
      <View style={{ gap: theme.space.xs }}>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Weight</Text>
        <SegmentedControl
          options={[
            { label: 'kg', value: 'kg' as UnitWeight },
            { label: 'lb', value: 'lb' as UnitWeight },
          ]}
          value={unitWeight}
          onChange={(value) => onChange({ unitWeight: value })}
        />
      </View>
      <View style={{ gap: theme.space.xs }}>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Distance</Text>
        <SegmentedControl
          options={[
            { label: 'km', value: 'km' as UnitDistance },
            { label: 'mi', value: 'mi' as UnitDistance },
          ]}
          value={unitDistance}
          onChange={(value) => onChange({ unitDistance: value })}
        />
      </View>
    </SectionCard>
  );
}
