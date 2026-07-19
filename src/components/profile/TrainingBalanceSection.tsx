import React, { useState } from 'react';
import { Text } from 'react-native';

import { theme } from '../../theme';
import { BalanceTrack } from '../BalanceTrack';
import { SectionCard } from './SectionCard';

type Props = {
  trainingBalanceRun: number;
  onChange: (runShare: number) => void;
};

/**
 * screens-phase-0.md §F.2. No SyncStatusPill here — deliberately: this value
 * is device-local-only for now (see
 * src/db/repositories/localPreferencesRepository.ts for the flagged schema
 * gap), and showing a sync pill would falsely imply it's backed up to the
 * server. A plain caption says exactly what's true instead.
 */
export function TrainingBalanceSection({ trainingBalanceRun, onChange }: Props) {
  const [value, setValue] = useState(trainingBalanceRun);

  const handleChange = (next: number) => {
    setValue(next);
    onChange(next);
  };

  return (
    <SectionCard title="Training balance">
      <BalanceTrack value={value} onChange={handleChange} />
      <Text style={[theme.type.caption, { color: theme.color.text.secondary }]}>
        Saved on this device. Cross-device sync for this setting is coming in a later phase.
      </Text>
    </SectionCard>
  );
}
